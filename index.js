// index.js
const express = require('express');
const pa11y = require('pa11y');
const PDFDocument = require('pdfkit');
const bodyParser = require('body-parser');
const session = require('express-session');
const puppeteer = require('puppeteer');
const Crawler = require('simplecrawler');  // new dependency

const app = express();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve static files (like CSS)

app.use(session({
  secret: 'your-secret-key', // Use a secure secret in production
  resave: false,
  saveUninitialized: true,
}));

// Set EJS as our view engine
app.set('view engine', 'ejs');

// Route: Home page with input box
app.get('/', (req, res) => {
  res.render('index');
});

// Existing route for a single page test
app.post('/test', async (req, res) => {
  let url = req.body.url.trim();
  // Add protocol if missing
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  
  try {
    // Run the accessibility test
    const results = await pa11y(url);

    // Compute a basic accessibility score:
    // Start at 100 and subtract 5 points for each issue (min score = 0)
    let score = 100;
    if (results.issues && results.issues.length > 0) {
      score = Math.max(100 - results.issues.length * 5, 0);
    }
    results.score = score;

    // Add the test date
    results.dateTested = new Date();

    // Capture a screenshot of the page using Puppeteer
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    const screenshotBuffer = await page.screenshot();
    await browser.close();
    // Store screenshot as a Base64 string
    results.screenshot = screenshotBuffer.toString('base64');

    // Compute summary for severity and WCAG levels
    const summary = {
      error: 0,
      warning: 0,
      notice: 0,
      levelA: 0,
      levelAA: 0,
      levelAAA: 0,
    };

    if (results.issues && results.issues.length > 0) {
      results.issues.forEach(issue => {
        // Count severity (defaulting to 'error' if type not defined)
        const type = (issue.type || 'error').toLowerCase();
        if (type === 'error') summary.error++;
        else if (type === 'warning') summary.warning++;
        else if (type === 'notice') summary.notice++;

        // Count WCAG level if provided
        if (issue.wcagLevel) {
          if (issue.wcagLevel === 'A') summary.levelA++;
          else if (issue.wcagLevel === 'AA') summary.levelAA++;
          else if (issue.wcagLevel === 'AAA') summary.levelAAA++;
        }
      });
    }
    results.summary = summary;

    // Group similar issues by their error code
    let groupedIssues = {};
    if (results.issues && results.issues.length > 0) {
      results.issues.forEach(issue => {
        if (!groupedIssues[issue.code]) {
          groupedIssues[issue.code] = [];
        }
        groupedIssues[issue.code].push(issue);
      });
    }
    results.groupedIssues = groupedIssues;

    // Store results in session so we can use them for PDF generation
    req.session.results = results;
    res.render('results', { results });
  } catch (error) {
    res.send('Error running accessibility test: ' + error.message);
  }
});

// New route: Crawl the site and test multiple pages
app.post('/crawl', async (req, res) => {
  let startUrl = req.body.url.trim();
  // Add protocol if missing
  if (!/^https?:\/\//i.test(startUrl)) {
    startUrl = 'https://' + startUrl;
  }

  const urlObj = new URL(startUrl);
  const domain = urlObj.hostname;

  // Array to hold URLs to be tested
  let pagesToTest = [];

  // Configure the crawler
  const crawler = new Crawler(startUrl);
  // Limit crawling to the same domain
  crawler.hostBlacklist = [];
  crawler.addFetchCondition((queueItem, referrerQueueItem) => {
    return new URL(queueItem.url).hostname === domain;
  });
  
  // Only process HTML pages
  crawler.downloadUnsupported = false;
  crawler.discoverResources = true;

  // Event: For each fetched page, if HTML then add to our list.
  crawler.on("fetchcomplete", (queueItem, responseBuffer, response) => {
    if (response.headers['content-type'] && response.headers['content-type'].includes("text/html")) {
      pagesToTest.push(queueItem.url);
    }
  });

  // Once crawling is complete, run pa11y on each page sequentially
  crawler.on("complete", async () => {
    let crawlResults = [];
    for (const pageUrl of pagesToTest) {
      try {
        const result = await pa11y(pageUrl);
        result.pageUrl = pageUrl;
        // (Optionally: compute scores, summaries, etc. per page)
        crawlResults.push(result);
      } catch (err) {
        console.error("Error testing page:", pageUrl, err);
      }
    }
    // Render a new view to display crawl results
    res.render('crawlResults', { resultsArray: crawlResults });
  });

  // Start crawling
  crawler.start();
});

// Route: Download PDF report of test results (for single page)
app.get('/download', (req, res) => {
  const results = req.session.results;
  if (!results) {
    return res.send('No results available. Please run a test first.');
  }
  
  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="accessibility_report.pdf"');

  doc.pipe(res);

  // PDF Header
  doc.fontSize(18).text('Accessibility Test Report', { underline: true });
  doc.moveDown();
  doc.fontSize(14).text(`Tested URL: ${results.pageUrl}`);
  doc.moveDown();
  doc.text(`Accessibility Score: ${results.score}/100`);
  doc.moveDown();
  doc.text(`Date Tested: ${new Date(results.dateTested).toLocaleString()}`);
  doc.moveDown();

  // Insert the screenshot into the PDF if available
  if (results.screenshot) {
    const screenshotBuffer = Buffer.from(results.screenshot, 'base64');
    try {
      doc.image(screenshotBuffer, { width: 400 });
      doc.moveDown();
    } catch (err) {
      doc.text('Error displaying screenshot in PDF.');
    }
  }

  // Grouped Issues
  if (results.issues && results.issues.length > 0) {
    doc.fontSize(16).text('Issues:', { underline: true });
    doc.moveDown();
    Object.keys(results.groupedIssues).forEach(code => {
      const group = results.groupedIssues[code];
      doc.fontSize(14).text(`Code: ${code} (Total: ${group.length})`, { underline: true });
      group.forEach((issue, index) => {
        doc.fontSize(12).text(`${index + 1}. Message: ${issue.message}`);
        doc.text(`Selector: ${issue.selector}`);
        doc.moveDown();
      });
    });
  } else {
    doc.fontSize(14).text('No accessibility issues found!');
  }
  
  doc.end();
});

// Start the server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});