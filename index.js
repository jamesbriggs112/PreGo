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

// Route for a single page test
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
    // Score = 100 - (5 * total issues); minimum 0.
    let score = 100;
    if (results.issues && results.issues.length > 0) {
      score = Math.max(100 - results.issues.length * 5, 0);
    }
    results.score = score;

    // Add the test date
    results.dateTested = new Date();

    // Capture screenshot and meta data using Puppeteer
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    const screenshotBuffer = await page.screenshot();
    // Capture meta data, including OG tags and favicon
    const metaData = await page.evaluate(() => {
      return {
        metaTitle: document.title || 'Not found',
        metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') || 'Not found',
        metaViewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || 'Not found',
        favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') || 'Not found',
        ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') || document.title || 'Not found',
        ogDescription: document.querySelector('meta[property="og:description"]')?.getAttribute('content') || 'Not found',
        ogImage: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || 'Not found',
        ogVideo: document.querySelector('meta[property="og:video"]')?.getAttribute('content') || 'Not found'
      };
    });
    await browser.close();
    results.screenshot = screenshotBuffer.toString('base64');
    results.metaData = metaData;

    // Group similar issues by their error code
    let groupedIssues = {};
    if (results.issues && results.issues.length > 0) {
      results.issues.forEach(issue => {
        const codeKey = issue.code ? issue.code : "Unknown";
        if (!groupedIssues[codeKey]) {
          groupedIssues[codeKey] = [];
        }
        groupedIssues[codeKey].push(issue);
      });
    }
    results.groupedIssues = groupedIssues;

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
        const type = (issue.type || 'error').toLowerCase();
        if (type === 'error') summary.error++;
        else if (type === 'warning') summary.warning++;
        else if (type === 'notice') summary.notice++;
        
        if (issue.code) {
          if (issue.code.includes('WCAG2AAA')) {
            summary.levelAAA++;
          } else if (issue.code.includes('WCAG2AA')) {
            summary.levelAA++;
          } else if (issue.code.includes('WCAG2A')) {
            summary.levelA++;
          }
        }
      });
    }
    results.summary = summary;

    // Save results in session and redirect to summary dashboard
    req.session.results = results;
    res.redirect('/results');
  } catch (error) {
    res.send('Error running accessibility test: ' + error.message);
  }
});

// Route: Summary Dashboard
app.get('/results', (req, res) => {
  const results = req.session.results;
  if (!results) return res.send('No results available. Please run a test first.');
  res.render('results', { results });
});

// Route: Full Accessibility Details Page
app.get('/accessibility-details', (req, res) => {
  const results = req.session.results;
  if (!results) return res.send('No results available. Please run a test first.');
  res.render('accessibility-details', { results });
});

// Route: Full Meta Data Details Page
app.get('/meta-details', (req, res) => {
  const results = req.session.results;
  if (!results || !results.metaData) return res.send('No meta data available. Please run a test first.');
  res.render('meta-details', { meta: results.metaData });
});

// Route: Download PDF report of test results (for single page)
app.get('/download', (req, res) => {
  const results = req.session.results;
  if (!results) return res.send('No results available. Please run a test first.');
  
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

// Route: Crawl the site and test multiple pages (unchanged)
app.post('/crawl', async (req, res) => {
  let startUrl = req.body.url.trim();
  if (!/^https?:\/\//i.test(startUrl)) {
    startUrl = 'https://' + startUrl;
  }
  const urlObj = new URL(startUrl);
  const domain = urlObj.hostname;
  let pagesToTest = [];
  const crawler = new Crawler(startUrl);
  crawler.hostBlacklist = [];
  crawler.addFetchCondition((queueItem, referrerQueueItem) => {
    return new URL(queueItem.url).hostname === domain;
  });
  crawler.downloadUnsupported = false;
  crawler.discoverResources = true;
  crawler.on("fetchcomplete", (queueItem, responseBuffer, response) => {
    if (response.headers['content-type'] && response.headers['content-type'].includes("text/html")) {
      pagesToTest.push(queueItem.url);
    }
  });
  crawler.on("complete", async () => {
    let crawlResults = [];
    for (const pageUrl of pagesToTest) {
      try {
        const result = await pa11y(pageUrl);
        result.pageUrl = pageUrl;
        crawlResults.push(result);
      } catch (err) {
        console.error("Error testing page:", pageUrl, err);
      }
    }
    res.render('crawlResults', { resultsArray: crawlResults });
  });
  crawler.start();
});

// Start the server
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});