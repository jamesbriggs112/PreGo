// index.js
const express = require('express');
const pa11y = require('pa11y');
const PDFDocument = require('pdfkit');
const bodyParser = require('body-parser');
const session = require('express-session');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');  // For security headers
const Crawler = require('simplecrawler'); // If you use the crawl route

const app = express();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

app.use(session({
  secret: 'your-secret-key', // Use a secure secret in production
  resave: false,
  saveUninitialized: true,
}));

app.set('view engine', 'ejs');

// Home page
app.get('/', (req, res) => {
  res.render('index');
});

// Single-page test route
app.post('/test', async (req, res) => {
  let url = req.body.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  
  try {
    // Run pa11y test
    const results = await pa11y(url);

    // Compute a basic accessibility score: 100 - 5 * (number of issues), min 0.
    let score = 100;
    if (results.issues && results.issues.length > 0) {
      score = Math.max(100 - results.issues.length * 5, 0);
    }
    results.score = score;

    // Add test date
    results.dateTested = new Date();

    // Use Puppeteer to capture a screenshot
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    const screenshotBuffer = await page.screenshot();
    results.screenshot = screenshotBuffer.toString('base64');
    await browser.close();

    // Security checks: fetch response headers using node-fetch
    const headerResponse = await fetch(url);
    const securityHeaders = headerResponse.headers.raw();
    results.securityHeaders = securityHeaders;

    // Define security checks (for example: CSP, Strict-Transport-Security, X-Frame-Options)
    const checks = {
      csp: !!securityHeaders['content-security-policy'],
      sts: !!securityHeaders['strict-transport-security'],
      xfo: !!securityHeaders['x-frame-options']
    };
    let passedCount = 0;
    const totalChecks = Object.keys(checks).length;
    for (const key in checks) {
      if (checks[key]) passedCount++;
    }
    const securityScore = Math.round((passedCount / totalChecks) * 100);
    function getLetterGrade(score) {
      if (score >= 95) return 'A+';
      if (score >= 90) return 'A';
      if (score >= 80) return 'B';
      if (score >= 70) return 'C';
      if (score >= 60) return 'D';
      return 'F';
    }
    const letterGrade = getLetterGrade(securityScore);
    results.securitySummary = {
      score: securityScore,
      letterGrade,
      passedCount,
      totalChecks,
      checks
    };

    // Group accessibility issues by error code
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

    // (Assume meta data is already captured elsewhere if needed)
    // For now, we assume meta data is in results.metaData if available.

    req.session.results = results;
    res.redirect('/results');
  } catch (err) {
    res.send('Error running test: ' + err.message);
  }
});

// Summary Dashboard
app.get('/results', (req, res) => {
  const results = req.session.results;
  if (!results) return res.send('No results available. Please run a test first.');
  res.render('results', { results });
});

// Full Accessibility Details
app.get('/accessibility-details', (req, res) => {
  const results = req.session.results;
  if (!results || !results.groupedIssues) return res.send('No accessibility details found. Please run a test first.');
  res.render('accessibility-details', { results });
});

// Full Meta Data Details
app.get('/meta-details', (req, res) => {
  const results = req.session.results;
  if (!results || !results.metaData) return res.send('No meta data found. Please run a test first.');
  res.render('meta-details', { meta: results.metaData });
});

// Full Security Details
app.get('/security-details', (req, res) => {
  const results = req.session.results;
  if (!results || !results.securitySummary) return res.send('No security data found. Please run a test first.');
  res.render('security-details', { results });
});

// PDF Report Route
app.get('/download', (req, res) => {
  const results = req.session.results;
  if (!results) return res.send('No results available. Please run a test first.');

  const doc = new PDFDocument();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="accessibility_report.pdf"');
  doc.pipe(res);

  doc.fontSize(18).text('Accessibility Test Report', { underline: true });
  doc.moveDown();
  doc.fontSize(14).text(`Tested URL: ${results.pageUrl}`);
  doc.moveDown();
  doc.text(`Accessibility Score: ${results.score}/100`);
  doc.moveDown();
  doc.text(`Date Tested: ${new Date(results.dateTested).toLocaleString()}`);
  doc.moveDown();

  if (results.screenshot) {
    const screenshotBuffer = Buffer.from(results.screenshot, 'base64');
    try {
      doc.image(screenshotBuffer, { width: 400 });
      doc.moveDown();
    } catch (err) {
      doc.text('Error displaying screenshot in PDF.');
    }
  }

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

// Crawl route (if used)
app.post('/crawl', async (req, res) => {
  // ... your crawl route code ...
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});