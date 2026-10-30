Pa11y Dashboard - Terminal Commands
====================================

1. Navigate to the project folder:
   cd /path/to/pa11y-dashboard

2. Initialize the npm project (if not already done):
   npm init -y

3. Install the required dependencies:
   npm install express pa11y pdfkit body-parser express-session puppeteer simplecrawler

   Note: Materialize CSS is loaded via CDN, so no installation is needed for that.

4. Run the project:
   node index.js

5. Open your browser and visit:
   http://localhost:3000

Additional Notes:
-----------------
- For crawling, the /crawl route is implemented and capped to 5 pages.
- Make sure you have a stable internet connection as Puppeteer downloads a Chromium instance when first run.
- Check the console for any errors if the project doesn't run as expected.