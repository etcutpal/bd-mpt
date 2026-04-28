const express = require('express');
const session = require('express-session');
const multer = require('multer');
const csvParser = require('csv-parser');
const fastCsv = require('fast-csv');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx-js-style');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'police-audit-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// Multer Configuration
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// Helper: Generate summary from rows
function generateSummary(rows) {
  const dateMap = new Map();

  for (const row of rows) {
    const timeStr = row['File Time']?.trim();
    if (!timeStr) continue;
    
    const date = timeStr.split(' ')[0];
    if (!date) continue;

    if (!dateMap.has(date)) {
      dateMap.set(date, {
        totalFiles: 0,
        uploaded: 0,
        notUploaded: 0,
        policeIDs: new Set(),
        deviceSNs: new Set()
      });
    }

    const d = dateMap.get(date);
    d.totalFiles++;

    const status = row['Upload Status']?.trim();
    if (status === 'Uploaded') d.uploaded++;
    else d.notUploaded++;

    const pid = row['Police ID']?.trim();
    if (pid) d.policeIDs.add(pid);

    const dsn = row['Device SN']?.trim();
    if (dsn) d.deviceSNs.add(dsn);
  }

  return Array.from(dateMap.entries())
    .map(([date, data]) => ({
      date,
      totalFiles: data.totalFiles,
      uploaded: data.uploaded,
      notUploaded: data.notUploaded,
      uniquePoliceIDCount: data.policeIDs.size,
      uniqueDeviceSNCount: data.deviceSNs.size,
      policeIDs: Array.from(data.policeIDs).sort(),
      deviceSNs: Array.from(data.deviceSNs).sort()
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Helper: Generate report rows for CSV
function generateReportRows(summaryData, selectedDates) {
  const filtered = selectedDates && selectedDates.length > 0 
    ? summaryData.filter(s => selectedDates.includes(s.date))
    : summaryData;

  const rows = [];
  // Section 1: Summary
  rows.push(['Date', 'Total Files', 'Uploaded', 'Not Uploaded', '% Upload Done', '% Remaining', 'Unique Police ID Count', 'Unique Device SN Count']);
  filtered.forEach(s => {
    const uploadPct = s.totalFiles > 0 ? ((s.uploaded / s.totalFiles) * 100).toFixed(1) + '%' : '0.0%';
    const remainPct = s.totalFiles > 0 ? ((s.notUploaded / s.totalFiles) * 100).toFixed(1) + '%' : '0.0%';
    rows.push([s.date, s.totalFiles, s.uploaded, s.notUploaded, uploadPct, remainPct, s.uniquePoliceIDCount, s.uniqueDeviceSNCount]);
  });
  rows.push([]); // Blank separator
  // Section 2: Police IDs
  rows.push(['DATE', 'UNIQUE POLICE IDs']);
  filtered.forEach(s => rows.push([s.date, s.policeIDs.join(',')]));
  rows.push([]);
  // Section 3: Device SNs
  rows.push(['DATE', 'UNIQUE DEVICE SNs']);
  filtered.forEach(s => rows.push([s.date, s.deviceSNs.join(',')]));
  return rows;
}

// 1. POST /upload
app.post('/upload', upload.single('csvfile'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const rows = [];
  const stream = fs.createReadStream(req.file.path).pipe(csvParser({ mapHeaders: ({ header }) => header.trim() }));

  stream.on('data', (row) => rows.push(row));
  
  stream.on('error', (err) => {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ success: false, message: 'CSV parsing failed. Check file format.' });
  });

  stream.on('end', () => {
    fs.unlink(req.file.path, (err) => { if (err) console.error('Cleanup error:', err); });
    req.session.rawData = rows;
    req.session.summaryData = generateSummary(rows);

    res.json({
      success: true,
      message: 'File processed successfully.',
      filename: req.file.originalname,
      summary: req.session.summaryData
    });
  });
});

// 2. GET /summary
app.get('/summary', (req, res) => {
  const summaryData = req.session.summaryData || [];
  if (summaryData.length === 0) {
    return res.status(404).json({ success: false, message: 'No data uploaded.' });
  }
  res.json({ success: true, summary: summaryData });
});

// 3. POST /download-report (CSV)
app.post('/download-report', (req, res) => {
  const summaryData = req.session.summaryData || [];
  if (summaryData.length === 0) {
    return res.status(404).json({ success: false, message: 'No data available to download.' });
  }

  const { selectedDates } = req.body || {};
  const datesToFilter = Array.isArray(selectedDates) && selectedDates.length > 0 ? selectedDates : null;
  const csvRows = generateReportRows(summaryData, datesToFilter);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=report-${timestamp}.csv`);

  const csvStream = fastCsv.format({ headers: false, quoteColumns: false });
  csvStream.pipe(res);
  csvStream.write(csvRows);
  csvStream.end();
});

// 4. POST /download-excel
app.post('/download-excel', (req, res) => {
  const summaryData = req.session.summaryData || [];
  if (summaryData.length === 0) {
    return res.status(404).json({ success: false, message: 'No data available to download.' });
  }

  const { selectedDates } = req.body || {};
  const filtered = selectedDates && selectedDates.length > 0 
    ? summaryData.filter(s => selectedDates.includes(s.date))
    : summaryData;

  if (filtered.length === 0) {
    return res.status(400).json({ success: false, message: 'No data for selected dates.' });
  }

  const wsData = [];
  wsData.push(['Date', 'Total Files', 'Uploaded', 'Not Uploaded', '% Upload Done', '% Remaining', 'Unique Police ID Count', 'Unique Device SNs', 'Unique Police IDs']);
  
  let currentRow = 2; 
  const merges = [];

  filtered.forEach((item) => {
    const maxRows = Math.max(item.policeIDs.length, item.deviceSNs.length, 1);
    const startRow = currentRow;
    const uploadPct = item.totalFiles > 0 ? parseFloat(((item.uploaded / item.totalFiles) * 100).toFixed(1)) : 0;
    const remainPct = item.totalFiles > 0 ? parseFloat(((item.notUploaded / item.totalFiles) * 100).toFixed(1)) : 0;
    
    for (let i = 0; i < maxRows; i++) {
      wsData.push([
        i === 0 ? item.date : '',
        i === 0 ? item.totalFiles : '',
        i === 0 ? item.uploaded : '',
        i === 0 ? item.notUploaded : '',
        i === 0 ? uploadPct + '%' : '',
        i === 0 ? remainPct + '%' : '',
        i === 0 ? item.uniquePoliceIDCount : '',
        item.deviceSNs[i] || '',
        item.policeIDs[i] || ''
      ]);
      currentRow++;
    }
    
    if (maxRows > 1) {
      for (let col = 0; col < 7; col++) {
        merges.push({ s: { r: startRow - 1, c: col }, e: { r: startRow + maxRows - 2, c: col } });
      }
    }
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  
  const headerCells = ['A1', 'B1', 'C1', 'D1', 'E1', 'F1', 'G1', 'H1', 'I1'];
  headerCells.forEach(cell => {
    if (ws[cell]) {
      ws[cell].s = ws[cell].s || {};
      ws[cell].s.alignment = { vertical: 'center' };
    }
  });

  const range = XLSX.utils.decode_range(ws['!ref']);
  const thinBorder = { style: "thin", color: { rgb: "000000" } };
  const borderStyle = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
  
  for (let R = range.s.r; R <= range.e.r; ++R) {
    for (let C = range.s.c; C <= range.e.c; ++C) {
      const cellAddress = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[cellAddress]) ws[cellAddress] = { v: "" };
      ws[cellAddress].s = ws[cellAddress].s || {};
      ws[cellAddress].s.border = borderStyle;
    }
  }

  ws['!merges'] = merges;
  ws['!cols'] = [
    { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 14 }, { wch: 24 }, { wch: 25 }, { wch: 20 }
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Detailed Report');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=detailed-report-${timestamp}.xlsx`);
  res.send(buffer);
});

// 5. POST /compare-reference (NEW: Compare by selected dates)
app.post('/compare-reference', upload.single('referenceFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No reference file uploaded.' });
  
  try {
    // 1. Read the uploaded Reference Excel
    const workbook = XLSX.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    // 2. Extract User IDs from Reference
    const referenceUserIds = new Set();
    jsonData.forEach(row => {
      if (row['User ID']) {
        referenceUserIds.add(String(row['User ID']).trim());
      }
    });

    // 3. Get selected dates from frontend
    let datesToCompare = [];
    if (req.body.selectedDates) {
      try {
        datesToCompare = JSON.parse(req.body.selectedDates);
      } catch (e) {
        console.error("Error parsing selectedDates", e);
      }
    }
    
    // If no dates selected, compare all dates
    const summaryData = req.session.summaryData || [];
    if (!datesToCompare || datesToCompare.length === 0) {
      datesToCompare = summaryData.map(s => s.date);
    }

    // 4. Compare Per Date
    const resultsByDate = [];
    const allUploadedIds = new Set();

    datesToCompare.forEach(date => {
      const dayData = summaryData.find(s => s.date === date);
      
      if (dayData) {
        const policeIdsForDate = dayData.policeIDs || [];
        policeIdsForDate.forEach(id => allUploadedIds.add(id));

        // Find missing: In Reference but NOT in this date's upload
        // Optimization: Convert policeIdsForDate to a Set for O(1) lookup
        const uploadedSet = new Set(policeIdsForDate);
        const missingForDate = [];
        referenceUserIds.forEach(refId => {
          if (!uploadedSet.has(refId)) {
            missingForDate.push(refId);
          }
        });

        resultsByDate.push({
          date: date,
          totalReference: referenceUserIds.size,
          totalUploaded: policeIdsForDate.length,
          missing: missingForDate.sort()
        });
      }
    });

    // Clean up temp file
    fs.unlink(req.file.path, () => {});

    res.json({
      success: true,
      results: resultsByDate,
      allUniqueUploadedIds: Array.from(allUploadedIds).sort()
    });

  } catch (err) {
    console.error(err);
    if(req.file && fs.existsSync(req.file.path)) fs.unlink(req.file.path, () => {});
    res.status(500).json({ success: false, message: 'Failed to compare files.' });
  }
});

// ============================================================
// START: Device IP Search Feature
// ============================================================

// Helper: Recursively collect all .xlsx / .xls files under a directory
function deviceSearch_getAllExcelFiles(dir) {
  let results = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(deviceSearch_getAllExcelFiles(fullPath));
    } else if (/\.(xlsx|xls)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

// Helper: Parse an Excel file and return rows as array of objects (headers trimmed)
function deviceSearch_parseExcelFile(filePath) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    // Trim all header keys
    return rows.map(row => {
      const cleaned = {};
      for (const key of Object.keys(row)) cleaned[key.trim()] = String(row[key]).trim();
      return cleaned;
    });
  } catch (e) {
    console.error(`deviceSearch: Failed to parse ${filePath}:`, e.message);
    return [];
  }
}

const DEVICE_ORG_DIR = path.join(__dirname, 'file', 'organization');
const DEVICE_USER_DIR = path.join(__dirname, 'file', 'user');

// GET /api/device-search?ip=<Device IP>
// Searches all org files for the IP, then matches user files by Org Code + Organization
app.get('/api/device-search', (req, res) => {
  const searchIp = (req.query.ip || '').trim();
  if (!searchIp) return res.status(400).json({ success: false, message: 'IP parameter is required.' });

  // --- Scan organization files ---
  const orgFiles = deviceSearch_getAllExcelFiles(DEVICE_ORG_DIR);
  let deviceMatch = null;

  for (const filePath of orgFiles) {
    const rows = deviceSearch_parseExcelFile(filePath);
    const row = rows.find(r => r['Device IP'] === searchIp);
    if (row) {
      deviceMatch = {
        sourceFile: path.relative(__dirname, filePath).replace(/\\/g, '/'),
        deviceName: row['Device Name*'] || row['Device Name'] || '',
        organizationCode: row['Organization Code*'] || row['Organization Code'] || '',
        organization: row['Organization'] || ''
      };
      break;
    }
  }

  if (!deviceMatch) {
    return res.json({ success: true, found: false, message: `No device found with IP: ${searchIp}` });
  }

  // --- Scan user files and match by Org Code + Organization ---
  const userFiles = deviceSearch_getAllExcelFiles(DEVICE_USER_DIR);
  const matchedUsers = [];

  for (const filePath of userFiles) {
    const rows = deviceSearch_parseExcelFile(filePath);
    for (const row of rows) {
      const rowOrgCode = row['Organization Code'] || '';
      const rowOrg = row['Organization'] || '';
      if (
        rowOrgCode === deviceMatch.organizationCode &&
        rowOrg === deviceMatch.organization
      ) {
        matchedUsers.push({
          userId: row['User ID'] || '',
          userName: row['User name'] || row['Username'] || '',
          sourceFile: path.relative(__dirname, filePath).replace(/\\/g, '/')
        });
      }
    }
  }

  res.json({
    success: true,
    found: true,
    device: deviceMatch,
    users: matchedUsers
  });
});

// GET /api/device-view
// Returns combined view: each device row + matched user IDs from user files
app.get('/api/device-view', (req, res) => {
  const orgFiles = deviceSearch_getAllExcelFiles(DEVICE_ORG_DIR);
  const userFiles = deviceSearch_getAllExcelFiles(DEVICE_USER_DIR);

  // Parse all user rows once, indexed by "orgCode|organization"
  const userMap = new Map();
  for (const filePath of userFiles) {
    const rows = deviceSearch_parseExcelFile(filePath);
    for (const row of rows) {
      const key = `${(row['Organization Code'] || '').toLowerCase()}|${(row['Organization'] || '').toLowerCase()}`;
      if (!userMap.has(key)) userMap.set(key, []);
      const uid = row['User ID'] || '';
      if (uid) userMap.get(key).push(uid);
    }
  }

  const results = [];
  for (const filePath of orgFiles) {
    const rows = deviceSearch_parseExcelFile(filePath);
    const relFile = path.relative(__dirname, filePath).replace(/\\/g, '/');
    for (const row of rows) {
      const orgCode = row['Organization Code*'] || row['Organization Code'] || '';
      const org = row['Organization'] || '';
      const key = `${orgCode.toLowerCase()}|${org.toLowerCase()}`;
      const userIds = userMap.get(key) || [];
      results.push({
        sourceFile: relFile,
        deviceIp: row['Device IP'] || '',
        deviceName: row['Device Name*'] || row['Device Name'] || '',
        organizationCode: orgCode,
        organization: org,
        userIds
      });
    }
  }

  res.json({ success: true, rows: results });
});

// ============================================================
// END: Device IP Search Feature
// ============================================================

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Internal server error.' });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});