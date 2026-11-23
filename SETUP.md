# finance dashboard: going live

The app holds no data. It reads the one google sheet you pick, using your own google sign-in.

## 1. put it on github pages

1. Create a new repo under ConversionAlchemy called `finance-dashboard`.
2. Upload `index.html`, `styles.css`, `app.js`, `_headers` and `favicon.png`.
3. Settings > Pages > Deploy from branch > `main` > `/ (root)`.
4. It goes live at `https://conversionalchemy.github.io/finance-dashboard/`.

## 2. google cloud (same project as the offer dashboard, about 5 minutes)

1. Open https://console.cloud.google.com and pick the "Conversion Alchemy Tools" project.
2. APIs & Services > Library: enable **Google Sheets API** and **Google Picker API**.
3. APIs & Services > Credentials > Create credentials > **API key**. Then edit the key:
   - Application restrictions: Websites > add `https://conversionalchemy.github.io/*`
   - API restrictions: Restrict key > **Google Picker API** only.
   - Copy the key.
4. In `app.js`, paste the key between the quotes in `const PICKER_API_KEY = "";` and upload `app.js` again.
5. The OAuth client already allows `https://conversionalchemy.github.io` and already uses the `drive.file` scope, so nothing else changes there.

## 3. use it

1. Open the page, click **sign in with google**.
2. The google file picker opens. Pick **conversion alchemy finance**.
3. From then on it reopens that sheet with one click. **open file** switches to another sheet, **sign out** forgets it.

## how it stays private

- `drive.file` means the app can only see the files you pick in the google picker. Nothing else in your drive.
- Nothing is stored on the page or the repo. The only thing kept in the browser is the id of the sheet you picked.
- Even with the link, nobody else can read the sheet: google checks the sheet's own sharing every time.
