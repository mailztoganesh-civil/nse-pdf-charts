# NSE Charts Android app

This folder is a complete, standalone Android Studio project for the NSE PDF
Chart Generator. It does not depend on the web application's source code.
It connects to the existing application API at `https://lsib.replit.app/api`.

## Features

- Start a full NSE chart-book generation job
- Enter an existing completed job ID
- Scroll through the generated stock names
- Tap any stock to view its generated candlestick chart
- Download the matching PDF chart book from the same screen

## Open and run

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repository root.
3. Open the repository root in Android Studio.
4. Let Android Studio sync Gradle.
5. Run the `app` configuration on an Android phone or emulator.

If using Git locally:

```bash
cd android-app
git init
git add .
git commit -m "Initial NSE Charts Android app"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

The server must be running or published at the API URL in
`app/src/main/java/com/nsecharts/android/MainActivity.kt`. If you publish the
backend under a different domain, change `API_BASE_URL` before building.

The Android app does not need a separate API key. Generated chart images and
the PDF are served by the same job API used by the web application.