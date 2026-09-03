package com.nsecharts.android

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.ShowChart
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

private const val API_BASE_URL = "https://lsib.replit.app/api"

data class JobStatus(
    val jobId: String,
    val status: String,
    val progress: Int,
    val total: Int,
    val message: String,
)

data class ChartSummary(
    val symbol: String,
    val name: String,
    val lastClose: Double,
    val chgPct: Double,
    val high52w: Double,
    val low52w: Double,
)

private object NseApi {
    suspend fun startAllCharts(): JobStatus = requestJson(
        path = "/jobs/generate-all",
        method = "POST",
        body = """{"historyMonths":6,"letterFilter":"ALL"}""",
    ).toJob()

    suspend fun getJob(jobId: String): JobStatus =
        requestJson("/jobs/${encode(jobId)}").toJob()

    suspend fun listCharts(jobId: String): List<ChartSummary> {
        val json = requestArray("/jobs/${encode(jobId)}/charts")
        return buildList {
            for (index in 0 until json.length()) {
                val item = json.getJSONObject(index)
                add(
                    ChartSummary(
                        symbol = item.getString("symbol"),
                        name = item.optString("name", item.getString("symbol")),
                        lastClose = item.optDouble("lastClose"),
                        chgPct = item.optDouble("chgPct"),
                        high52w = item.optDouble("high52w"),
                        low52w = item.optDouble("low52w"),
                    ),
                )
            }
        }
    }

    fun chartUrl(jobId: String, symbol: String): String =
        "$API_BASE_URL/jobs/${encode(jobId)}/charts/${encode(symbol)}"

    fun pdfUrl(jobId: String): String =
        "$API_BASE_URL/jobs/${encode(jobId)}/download"

    private suspend fun requestJson(
        path: String,
        method: String = "GET",
        body: String? = null,
    ): JSONObject = JSONObject(requestText(path, method, body))

    private suspend fun requestArray(
        path: String,
    ): JSONArray = JSONArray(requestText(path))

    private suspend fun requestText(
        path: String,
        method: String = "GET",
        body: String? = null,
    ): String = withContext(Dispatchers.IO) {
        val connection = (URL(API_BASE_URL + path).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 20_000
            readTimeout = 60_000
            setRequestProperty("Accept", "application/json")
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toByteArray()) }
            }
        }
        try {
            if (connection.responseCode !in 200..299) {
                throw IllegalStateException("API request failed with HTTP ${connection.responseCode}")
            }
            connection.inputStream.bufferedReader().use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun JSONObject.toJob() = JobStatus(
        jobId = getString("jobId"),
        status = getString("status"),
        progress = optInt("progress"),
        total = optInt("total"),
        message = optString("message"),
    )

    private fun encode(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}

data class ChartUiState(
    val jobId: String = "",
    val job: JobStatus? = null,
    val charts: List<ChartSummary> = emptyList(),
    val selectedIndex: Int = 0,
    val loading: Boolean = false,
    val error: String? = null,
)

class ChartViewModel : ViewModel() {
    var state by mutableStateOf(ChartUiState())
        private set

    fun updateJobId(value: String) {
        state = state.copy(jobId = value.trim(), error = null)
    }

    fun generateAll() {
        state = state.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val started = NseApi.startAllCharts()
                state = state.copy(job = started, jobId = started.jobId)
                waitForCompletion(started.jobId)
            } catch (error: Exception) {
                state = state.copy(loading = false, error = error.message ?: "Could not start generation.")
            }
        }
    }

    fun loadExisting() {
        val jobId = state.jobId.trim()
        if (jobId.isEmpty()) {
            state = state.copy(error = "Enter a completed job ID first.")
            return
        }
        state = state.copy(loading = true, error = null)
        viewModelScope.launch {
            try {
                val job = NseApi.getJob(jobId)
                if (job.status == "completed") {
                    loadCharts(job)
                } else {
                    state = state.copy(job = job, loading = false, error = "That job is ${job.status}.")
                }
            } catch (error: Exception) {
                state = state.copy(loading = false, error = error.message ?: "Could not load this job.")
            }
        }
    }

    fun selectChart(index: Int) {
        state = state.copy(selectedIndex = index.coerceIn(0, state.charts.lastIndex.coerceAtLeast(0)))
    }

    private suspend fun waitForCompletion(jobId: String) {
        var job = NseApi.getJob(jobId)
        while (job.status == "pending" || job.status == "running") {
            state = state.copy(job = job)
            delay(2_500)
            job = NseApi.getJob(jobId)
        }
        if (job.status != "completed") {
            state = state.copy(job = job, loading = false, error = job.message)
            return
        }
        loadCharts(job)
    }

    private suspend fun loadCharts(job: JobStatus) {
        val charts = NseApi.listCharts(job.jobId)
        state = state.copy(job = job, charts = charts, selectedIndex = 0, loading = false)
    }
}

private val AppBackground = Color(0xFF081019)
private val AppCard = Color(0xFF101C27)
private val AppAccent = Color(0xFF00C7B1)
private val AppText = Color(0xFFE3EEF5)
private val AppMuted = Color(0xFF93A8B6)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NseChartsApp(viewModel: ChartViewModel = viewModel()) {
    val state = viewModel.state
    val context = androidx.compose.ui.platform.LocalContext.current
    var jobIdInput by remember { mutableStateOf(state.jobId) }

    MaterialTheme(
        colorScheme = MaterialTheme.colorScheme.copy(
            background = AppBackground,
            surface = AppCard,
            primary = AppAccent,
            onBackground = AppText,
            onSurface = AppText,
        ),
    ) {
        Scaffold(
            containerColor = AppBackground,
            topBar = {
                TopAppBar(
                    title = {
                        Column {
                            Text("NSE CHARTS", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
                            Text("Scroll stocks · inspect charts · download PDF", style = MaterialTheme.typography.labelSmall, color = AppMuted)
                        }
                    },
                    navigationIcon = {
                        Icon(Icons.Default.ShowChart, contentDescription = null, tint = AppAccent, modifier = Modifier.padding(start = 16.dp))
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = AppBackground),
                )
            },
        ) { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Card(colors = CardDefaults.cardColors(containerColor = AppCard)) {
                    Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("CHART BOOK", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = AppAccent)
                        Text("Generate the full NSE PDF, then browse every generated stock chart in the app.", color = AppMuted)
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Button(onClick = viewModel::generateAll, enabled = !state.loading) {
                                Text("GENERATE ALL")
                            }
                            if (state.loading) CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
                        }
                        OutlinedTextField(
                            value = jobIdInput,
                            onValueChange = {
                                jobIdInput = it
                                viewModel.updateJobId(it)
                            },
                            label = { Text("Existing job ID") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Button(onClick = viewModel::loadExisting, enabled = !state.loading, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("LOAD COMPLETED JOB")
                        }
                        state.job?.let { job ->
                            Text("${job.status.uppercase()} · ${job.progress}/${job.total.coerceAtLeast(1)} · ${job.message}", color = AppMuted, style = MaterialTheme.typography.labelSmall)
                            if (job.status == "running" || job.status == "pending") {
                                LinearProgressIndicator(
                                    progress = { if (job.total > 0) job.progress.toFloat() / job.total else 0f },
                                    modifier = Modifier.fillMaxWidth(),
                                )
                            }
                        }
                        state.error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    }
                }

                if (state.charts.isNotEmpty()) {
                    ChartBook(
                        jobId = state.jobId,
                        charts = state.charts,
                        selectedIndex = state.selectedIndex,
                        onSelect = viewModel::selectChart,
                        onDownloadPdf = { downloadPdf(context, state.jobId) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ChartBook(
    jobId: String,
    charts: List<ChartSummary>,
    selectedIndex: Int,
    onSelect: (Int) -> Unit,
    onDownloadPdf: () -> Unit,
) {
    val selected = charts[selectedIndex.coerceIn(0, charts.lastIndex)]
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Card(colors = CardDefaults.cardColors(containerColor = AppCard)) {
            Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Column {
                        Text(selected.symbol, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.headlineSmall)
                        Text(selected.name, color = AppMuted, maxLines = 1)
                    }
                    Button(onClick = onDownloadPdf) {
                        Icon(Icons.Default.CloudDownload, contentDescription = null)
                        Spacer(Modifier.width(6.dp))
                        Text("PDF")
                    }
                }
                AsyncImage(
                    model = NseApi.chartUrl(jobId, selected.symbol),
                    contentDescription = "${selected.symbol} candlestick chart",
                    contentScale = ContentScale.Fit,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(250.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(Color.White),
                )
                Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                    Metric("CLOSE", "₹${"%,.2f".format(selected.lastClose)}")
                    Metric("PERIOD", "${if (selected.chgPct >= 0) "+" else ""}${"%.2f".format(selected.chgPct)}%")
                    Metric("52W RANGE", "₹${"%.0f".format(selected.low52w)} — ₹${"%.0f".format(selected.high52w)}")
                }
            }
        }

        Text("STOCKS · ${charts.size}", fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold, color = AppAccent)
        Card(colors = CardDefaults.cardColors(containerColor = AppCard)) {
            LazyColumn(
                modifier = Modifier.fillMaxWidth().height(360.dp),
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                itemsIndexed(charts) { index, chart ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSelect(index) }
                            .background(if (index == selectedIndex) AppAccent.copy(alpha = 0.14f) else Color.Transparent)
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("${index + 1}", color = AppMuted, modifier = Modifier.width(34.dp), fontFamily = FontFamily.Monospace)
                        Column(modifier = Modifier.weight(1f)) {
                            Text(chart.symbol, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Monospace)
                            Text(chart.name, color = AppMuted, maxLines = 1, style = MaterialTheme.typography.labelSmall)
                        }
                        Text(
                            "${if (chart.chgPct >= 0) "+" else ""}${"%.2f".format(chart.chgPct)}%",
                            color = if (chart.chgPct >= 0) AppAccent else MaterialTheme.colorScheme.error,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Metric(label: String, value: String) {
    Column {
        Text(label, color = AppMuted, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
        Text(value, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Bold)
    }
}

private fun downloadPdf(context: Context, jobId: String) {
    val request = DownloadManager.Request(Uri.parse(NseApi.pdfUrl(jobId)))
        .setTitle("NSE Charts PDF")
        .setDescription("Downloading the generated NSE chart book")
        .setMimeType("application/pdf")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        .setDestinationInExternalFilesDir(context, "Downloads", "NSE_Charts_$jobId.pdf")
    (context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { NseChartsApp() }
    }
}