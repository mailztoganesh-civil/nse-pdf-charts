import SwiftUI
import PDFKit

// ─────────────────────────────────────────────
// MARK: – Configuration
// ─────────────────────────────────────────────

let BASE_URL = "https://lsib.replit.app/api"

// ─────────────────────────────────────────────
// MARK: – Models
// ─────────────────────────────────────────────

struct JobResponse: Codable {
    let jobId: String
    let status: String
    let progress: Int?
    let total: Int?
    let message: String?
    let stockCount: Int?
    let completedAt: String?
}

struct ParseCsvResponse: Codable {
    let stocks: [String]
    let stocksByDate: [String: [String]]?
    let dateRange: DateRange?

    struct DateRange: Codable {
        let start: String?
        let end: String?
    }
}

// ─────────────────────────────────────────────
// MARK: – API Client
// ─────────────────────────────────────────────

@MainActor
class NSEApi: ObservableObject {

    // ── Poll a job until done ──────────────────
    func pollJob(jobId: String, onProgress: @escaping (JobResponse) -> Void) async throws -> JobResponse {
        while true {
            let job = try await getJob(jobId: jobId)
            onProgress(job)
            if job.status == "completed" || job.status == "failed" { return job }
            try await Task.sleep(nanoseconds: 3_000_000_000) // 3 s
        }
    }

    func getJob(jobId: String) async throws -> JobResponse {
        let url = URL(string: "\(BASE_URL)/jobs/\(jobId)")!
        let (data, _) = try await URLSession.shared.data(from: url)
        return try JSONDecoder().decode(JobResponse.self, from: data)
    }

    func startAllNse(letterFilter: String, historyMonths: Int) async throws -> JobResponse {
        let url = URL(string: "\(BASE_URL)/jobs/generate-all")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["letterFilter": letterFilter, "historyMonths": historyMonths]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(JobResponse.self, from: data)
    }

    func parseCsv(data csvData: Data, filename: String) async throws -> ParseCsvResponse {
        let url = URL(string: "\(BASE_URL)/jobs/parse-csv")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        let boundary = "Boundary-\(UUID().uuidString)"
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        var body = Data()
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: text/csv\r\n\r\n".data(using: .utf8)!)
        body.append(csvData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        req.httpBody = body
        let (respData, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(ParseCsvResponse.self, from: respData)
    }

    func startCsvJob(stocks: [String], stocksByDate: [String: [String]]?, startDate: String, endDate: String, historyMonths: Int) async throws -> JobResponse {
        let url = URL(string: "\(BASE_URL)/jobs/generate-csv")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = [
            "stocks": stocks,
            "startDate": startDate,
            "endDate": endDate,
            "historyMonths": historyMonths
        ]
        if let sbd = stocksByDate { body["stocksByDate"] = sbd }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(JobResponse.self, from: data)
    }

    func downloadPdf(jobId: String) async throws -> Data {
        let url = URL(string: "\(BASE_URL)/jobs/\(jobId)/download")!
        let (data, resp) = try await URLSession.shared.data(from: url)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            throw NSError(domain: "NSECharts", code: 0, userInfo: [NSLocalizedDescriptionKey: "Download failed"])
        }
        return data
    }
}

// ─────────────────────────────────────────────
// MARK: – Main App
// ─────────────────────────────────────────────

@main
struct NSEChartsApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}

struct ContentView: View {
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            AllNseView()
                .tabItem { Label("All NSE", systemImage: "chart.bar.fill") }
                .tag(0)

            CsvUploadView()
                .tabItem { Label("CSV Upload", systemImage: "doc.text.fill") }
                .tag(1)
        }
        .accentColor(.blue)
    }
}

// ─────────────────────────────────────────────
// MARK: – All NSE Tab
// ─────────────────────────────────────────────

struct AllNseView: View {
    @StateObject private var api = NSEApi()

    @State private var letterFilter = "ALL"
    @State private var historyMonths = 6

    @State private var phase: Phase = .idle
    @State private var job: JobResponse?
    @State private var pdfData: Data?
    @State private var errorMsg = ""
    @State private var showPdf = false

    private let letterOptions = ["ALL","A-E","F-J","K-O","P-T","U-Z"]
    private let monthOptions  = [3, 6, 9, 12]

    enum Phase { case idle, running, done, failed }

    var body: some View {
        NavigationView {
            Form {
                Section("Filter") {
                    Picker("Letter range", selection: $letterFilter) {
                        ForEach(letterOptions, id: \.self) { Text($0).tag($0) }
                    }
                    Picker("History", selection: $historyMonths) {
                        ForEach(monthOptions, id: \.self) { Text("\($0) months").tag($0) }
                    }
                }

                Section {
                    Button(action: startJob) {
                        Label("Generate PDF", systemImage: "play.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(phase == .running)
                    .buttonStyle(.borderedProminent)
                }

                if phase == .running, let j = job {
                    Section("Progress") {
                        ProgressView(value: Double(j.progress ?? 0), total: Double(max(j.total ?? 1, 1)))
                        Text(j.message ?? "Working…").font(.caption).foregroundColor(.secondary)
                    }
                }

                if phase == .done {
                    Section {
                        Button(action: { showPdf = true }) {
                            Label("View PDF", systemImage: "doc.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        if let d = pdfData {
                            ShareLink(item: pdfExportItem(data: d, name: "NSE_\(letterFilter).pdf")) {
                                Label("Share / Save PDF", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                }

                if phase == .failed {
                    Section { Text("Error: \(errorMsg)").foregroundColor(.red) }
                }
            }
            .navigationTitle("All NSE Stocks")
            .sheet(isPresented: $showPdf) {
                if let d = pdfData { PDFViewer(data: d) }
            }
        }
    }

    private func startJob() {
        phase = .running
        job = nil
        pdfData = nil
        Task {
            do {
                let initial = try await api.startAllNse(letterFilter: letterFilter, historyMonths: historyMonths)
                let final = try await api.pollJob(jobId: initial.jobId) { j in
                    job = j
                }
                if final.status == "completed" {
                    pdfData = try await api.downloadPdf(jobId: final.jobId)
                    phase = .done
                } else {
                    errorMsg = final.message ?? "Unknown error"
                    phase = .failed
                }
            } catch {
                errorMsg = error.localizedDescription
                phase = .failed
            }
        }
    }
}

// ─────────────────────────────────────────────
// MARK: – CSV Upload Tab
// ─────────────────────────────────────────────

struct CsvUploadView: View {
    @StateObject private var api = NSEApi()

    @State private var showFilePicker = false
    @State private var csvFilename = ""
    @State private var parsedResult: ParseCsvResponse?
    @State private var historyMonths = 6

    @State private var phase: Phase = .idle
    @State private var job: JobResponse?
    @State private var pdfData: Data?
    @State private var errorMsg = ""
    @State private var showPdf = false

    private let monthOptions = [3, 6, 9, 12]

    enum Phase { case idle, parsing, running, done, failed }

    var body: some View {
        NavigationView {
            Form {
                Section("Step 1 — Upload Screener CSV") {
                    Button(action: { showFilePicker = true }) {
                        Label(csvFilename.isEmpty ? "Choose CSV file…" : csvFilename,
                              systemImage: "doc.badge.plus")
                    }
                    if let p = parsedResult {
                        Label("\(p.stocks.count) stocks found", systemImage: "checkmark.circle.fill")
                            .foregroundColor(.green)
                        if let dr = p.dateRange, let s = dr.start, let e = dr.end {
                            Text("Date range: \(s) → \(e)").font(.caption).foregroundColor(.secondary)
                        }
                    }
                }

                if parsedResult != nil {
                    Section("Step 2 — Options") {
                        Picker("History", selection: $historyMonths) {
                            ForEach(monthOptions, id: \.self) { Text("\($0) months").tag($0) }
                        }
                    }

                    Section("Step 3 — Generate") {
                        Button(action: startJob) {
                            Label("Generate PDF", systemImage: "play.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .disabled(phase == .running || phase == .parsing)
                        .buttonStyle(.borderedProminent)
                    }
                }

                if phase == .running, let j = job {
                    Section("Progress") {
                        ProgressView(value: Double(j.progress ?? 0), total: Double(max(j.total ?? 1, 1)))
                        Text(j.message ?? "Working…").font(.caption).foregroundColor(.secondary)
                    }
                }

                if phase == .done {
                    Section {
                        Button(action: { showPdf = true }) {
                            Label("View PDF", systemImage: "doc.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        if let d = pdfData {
                            ShareLink(item: pdfExportItem(data: d, name: "NSE_Screener.pdf")) {
                                Label("Share / Save PDF", systemImage: "square.and.arrow.up")
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    }
                }

                if phase == .failed {
                    Section { Text("Error: \(errorMsg)").foregroundColor(.red) }
                }
            }
            .navigationTitle("CSV Upload")
            .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.commaSeparatedText, .text]) { result in
                handleFilePick(result)
            }
            .sheet(isPresented: $showPdf) {
                if let d = pdfData { PDFViewer(data: d) }
            }
        }
    }

    private func handleFilePick(_ result: Result<URL, Error>) {
        switch result {
        case .failure(let e):
            errorMsg = e.localizedDescription; phase = .failed
        case .success(let url):
            csvFilename = url.lastPathComponent
            parsedResult = nil
            phase = .parsing
            Task {
                do {
                    guard url.startAccessingSecurityScopedResource() else {
                        throw NSError(domain: "NSECharts", code: 1, userInfo: [NSLocalizedDescriptionKey: "Permission denied"])
                    }
                    defer { url.stopAccessingSecurityScopedResource() }
                    let data = try Data(contentsOf: url)
                    let parsed = try await api.parseCsv(data: data, filename: csvFilename)
                    parsedResult = parsed
                    phase = .idle
                } catch {
                    errorMsg = error.localizedDescription
                    phase = .failed
                }
            }
        }
    }

    private func startJob() {
        guard let p = parsedResult else { return }
        phase = .running
        job = nil
        pdfData = nil

        let startDate = p.dateRange?.start ?? "2024-01-01"
        let endDate   = p.dateRange?.end   ?? "2024-12-31"

        Task {
            do {
                let initial = try await api.startCsvJob(
                    stocks: p.stocks,
                    stocksByDate: p.stocksByDate,
                    startDate: startDate,
                    endDate: endDate,
                    historyMonths: historyMonths
                )
                let final = try await api.pollJob(jobId: initial.jobId) { j in
                    job = j
                }
                if final.status == "completed" {
                    pdfData = try await api.downloadPdf(jobId: final.jobId)
                    phase = .done
                } else {
                    errorMsg = final.message ?? "Unknown error"
                    phase = .failed
                }
            } catch {
                errorMsg = error.localizedDescription
                phase = .failed
            }
        }
    }
}

// ─────────────────────────────────────────────
// MARK: – Helpers
// ─────────────────────────────────────────────

struct PDFViewer: UIViewRepresentable {
    let data: Data
    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.document = PDFDocument(data: data)
        return view
    }
    func updateUIView(_ uiView: PDFView, context: Context) {}
}

func pdfExportItem(data: Data, name: String) -> URL {
    let tmp = FileManager.default.temporaryDirectory.appendingPathComponent(name)
    try? data.write(to: tmp)
    return tmp
}
