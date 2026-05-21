const express = require('express');
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Config ---
const JUDGE_PASSWORD = process.env.JUDGE_PASSWORD || 'eternalgy2026';
const DATA_DIR = process.env.DATA_DIR || '/storage';
const SUBMISSIONS_DIR = path.join(DATA_DIR, 'submissions');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
[DATA_DIR, SUBMISSIONS_DIR, UPLOADS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Middleware ---
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'eternalgy-judge-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 4 * 60 * 60 * 1000 } // 4 hours
}));

// --- File upload config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const id = req.submissionId || uuidv4();
    req.submissionId = id;
    const ext = path.extname(file.originalname);
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'));
  }
});

// --- Routes ---

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Download source file
app.get('/download/source', (req, res) => {
  const locations = [
    path.join(DATA_DIR, 'source_file.zip'),
    path.join(__dirname, 'source_file.zip')
  ];
  const file = locations.find(f => fs.existsSync(f));
  if (file) res.download(file, 'Eternalgy-Source-Files.zip');
  else res.status(404).send('File not found');
});

// Download reference PDF
app.get('/download/profile', (req, res) => {
  const locations = [
    path.join(DATA_DIR, 'Eternalgy Profile 2025.pdf'),
    path.join(__dirname, 'Eternalgy Profile 2025.pdf')
  ];
  const file = locations.find(f => fs.existsSync(f));
  if (file) res.download(file, 'Eternalgy-Company-Profile-2025.pdf');
  else res.status(404).send('File not found');
});

// Form submission
app.post('/api/submit', (req, res, next) => {
  req.submissionId = uuidv4();
  next();
}, upload.single('pdf'), (req, res) => {
  try {
    const { name, email, phone, portfolio, experience, concept, agree_tnc, agree_original, agree_location } = req.body;

    if (!name || !email || !phone || !req.file) {
      return res.status(400).json({ error: 'Missing required fields (name, email, phone, pdf)' });
    }

    if (!agree_tnc || !agree_original || !agree_location) {
      return res.status(400).json({ error: 'You must agree to all terms before submitting.' });
    }

    const submission = {
      id: req.submissionId,
      name,
      email,
      phone,
      portfolio: portfolio || '',
      experience: experience || '',
      concept: concept || '',
      agreements: {
        tnc: true,
        originalWork: true,
        canWorkAtLocation: true
      },
      filename: req.file.originalname,
      filesize: req.file.size,
      storedAs: req.file.filename,
      submittedAt: new Date().toISOString(),
      status: 'pending' // pending | reviewed | shortlisted | rejected
    };

    // Save submission JSON
    const jsonPath = path.join(SUBMISSIONS_DIR, `${req.submissionId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(submission, null, 2), 'utf-8');

    res.json({ success: true, id: req.submissionId, message: 'Submission received!' });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// --- Judge routes ---

// Judge login page
app.get('/judge', (req, res) => {
  if (req.session && req.session.isJudge) {
    return res.sendFile(path.join(__dirname, 'public', 'judge.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'judge-login.html'));
});

// Judge auth
app.post('/judge/login', (req, res) => {
  const { password } = req.body;
  if (password === JUDGE_PASSWORD) {
    req.session.isJudge = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Judge logout
app.post('/judge/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Judge middleware
function requireJudge(req, res, next) {
  if (req.session && req.session.isJudge) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// Get all submissions
app.get('/api/submissions', requireJudge, (req, res) => {
  try {
    const files = fs.readdirSync(SUBMISSIONS_DIR).filter(f => f.endsWith('.json'));
    const submissions = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(SUBMISSIONS_DIR, f), 'utf-8'));
      return data;
    });
    // Sort by newest first
    submissions.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    res.json(submissions);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load submissions' });
  }
});

// Download a submission PDF
app.get('/api/submissions/:id/pdf', requireJudge, (req, res) => {
  const jsonPath = path.join(SUBMISSIONS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).send('Not found');

  const submission = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const filePath = path.join(UPLOADS_DIR, submission.storedAs);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

  res.download(filePath, submission.filename);
});

// Update submission status
app.patch('/api/submissions/:id', requireJudge, (req, res) => {
  const jsonPath = path.join(SUBMISSIONS_DIR, `${req.params.id}.json`);
  if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: 'Not found' });

  const submission = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  const { status, notes } = req.body;
  if (status) submission.status = status;
  if (notes !== undefined) submission.notes = notes;
  submission.reviewedAt = new Date().toISOString();

  fs.writeFileSync(jsonPath, JSON.stringify(submission, null, 2), 'utf-8');
  res.json(submission);
});

// Error handler for multer
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum 25MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, () => {
  console.log(`✦ Eternalgy Design Competition running on port ${PORT}`);
  console.log(`  → Landing page: http://localhost:${PORT}`);
  console.log(`  → Judge panel:  http://localhost:${PORT}/judge`);
  console.log(`  → Judge password: ${JUDGE_PASSWORD}`);
});
