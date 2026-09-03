# NSE Charts Android app

This is a GitHub-ready Android Studio project for the NSE PDF Chart Generator.
It connects to the existing application API at `https://lsib.replit.app/api`.

## Features

- Start a full NSE chart-book generation job
- Enter an existing completed job ID
- Scroll through the generated stock names
- Tap any stock to view its generated candlestick chart
- Download the matching PDF chart book from the same screen

## Open and run

1. Download or clone this repository.
2. Open the `android-app` folder in Android Studio.
3. Let Android Studio sync Gradle.
4. Run the `app` configuration on an Android phone or emulator.

The server must be running or published at the API URL in
`app/src/main/java/com/nsecharts/android/MainActivity.kt`. If you publish the
backend under a different domain, change `API_BASE_URL` before building.

The Android app does not need a separate API key. Generated chart images and
the PDF are served by the same job API used by the web application.