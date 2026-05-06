const express = require('express');
const session = require('express-session');
const multer = require('multer');
const csvParser = require('csv-parser');
const fastCsv = require('fast-csv');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx-js-style');

const app = express();
const PORT = process.env.PORT || 5001;

// Middleware
app.use(session({
  secret: process.env.SESSION_SECRET || 'police-audit-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using HTTPS
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

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
        deviceSNs: new Set(),
        zeroDeviceSNs: new Set()
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
    if (pid === '000000' && dsn) d.zeroDeviceSNs.add(dsn);
  }

  return Array.from(dateMap.entries())
    .map(([date, data]) => ({
      date,
      totalFiles: data.totalFiles,
      uploaded: data.uploaded,
      notUploaded: data.notUploaded,
      uniquePoliceIDCount: data.policeIDs.size,
      uniqueDeviceSNCount: data.deviceSNs.size,
      zeroDeviceCount: data.zeroDeviceSNs.size,
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

const DEVICE_ORG_DIR    = path.join(__dirname, 'file', 'organization');
const DEVICE_USER_DIR   = path.join(__dirname, 'file', 'user');
const DEVICE_BANGLA_DIR = path.join(__dirname, 'file', 'bangla');

// Helper: Build a lookup map from file3 (file/bangla/):  ID → { metroRange, district, policeStation, pollingCenter }
function deviceSearch_buildBanglaIndex() {
  const index = new Map();
  const files = deviceSearch_getAllExcelFiles(DEVICE_BANGLA_DIR);
  for (const filePath of files) {
    let rows;
    try { rows = deviceSearch_parseExcelFile(filePath); } catch (e) { continue; }
    for (const row of rows) {
      const id = (row['ID'] || '').trim();
      if (!id || index.has(id)) continue; // use first occurrence
      index.set(id, {
        metroRange:    row['Metro/Range']         || '',
        district:      row['District']            || '',
        policeStation: row['Police Station']      || '',
        pollingCenter: row['Polling Center Name'] || ''
      });
    }
  }
  return index;
}

// GET /api/device-scan-status
// Scans both folders and reports duplicate Device IPs and duplicate User IDs
app.get('/api/device-scan-status', (req, res) => {
  const orgFiles  = deviceSearch_getAllExcelFiles(DEVICE_ORG_DIR);
  const userFiles = deviceSearch_getAllExcelFiles(DEVICE_USER_DIR);

  // ── Org files: detect duplicate Device IPs ──────────────────────────────
  const ipIndex   = new Map(); // ip → [{ sourceFile, deviceName, orgCode, org }]
  let orgParseErrors = [];

  for (const filePath of orgFiles) {
    const relFile = path.relative(__dirname, filePath).replace(/\\/g, '/');
    let rows;
    try {
      rows = deviceSearch_parseExcelFile(filePath);
    } catch (e) {
      orgParseErrors.push({ file: relFile, error: e.message });
      continue;
    }
    for (const row of rows) {
      const ip = row['Device IP'] || '';
      if (!ip) continue;
      if (!ipIndex.has(ip)) ipIndex.set(ip, []);
      ipIndex.get(ip).push({
        sourceFile:  relFile,
        deviceName:  row['Device Name*'] || row['Device Name'] || '',
        orgCode:     row['Organization Code*'] || row['Organization Code'] || '',
        organization: row['Organization'] || ''
      });
    }
  }

  const duplicateIps = [];
  ipIndex.forEach((entries, ip) => {
    if (entries.length > 1) duplicateIps.push({ ip, entries });
  });

  // ── User files: detect duplicate User IDs (same org) ────────────────────
  const userIdIndex   = new Map(); // userId → [{ sourceFile, orgCode, org }]
  let userParseErrors = [];

  for (const filePath of userFiles) {
    const relFile = path.relative(__dirname, filePath).replace(/\\/g, '/');
    let rows;
    try {
      rows = deviceSearch_parseExcelFile(filePath);
    } catch (e) {
      userParseErrors.push({ file: relFile, error: e.message });
      continue;
    }
    for (const row of rows) {
      const uid = row['User ID'] || '';
      if (!uid) continue;
      if (!userIdIndex.has(uid)) userIdIndex.set(uid, []);
      userIdIndex.get(uid).push({
        sourceFile:   relFile,
        orgCode:      row['Organization Code'] || '',
        organization: row['Organization'] || ''
      });
    }
  }

  const duplicateUserIds = [];
  userIdIndex.forEach((entries, userId) => {
    if (entries.length > 1) duplicateUserIds.push({ userId, entries });
  });

  res.json({
    success: true,
    orgFiles:        orgFiles.map(f => path.relative(__dirname, f).replace(/\\/g, '/')),
    userFiles:       userFiles.map(f => path.relative(__dirname, f).replace(/\\/g, '/')),
    duplicateIps,
    duplicateUserIds,
    orgParseErrors,
    userParseErrors,
    summary: {
      totalOrgFiles:        orgFiles.length,
      totalUserFiles:       userFiles.length,
      totalUniqueIps:       ipIndex.size,
      totalUniqueUserIds:   userIdIndex.size,
      duplicateIpCount:     duplicateIps.length,
      duplicateUserIdCount: duplicateUserIds.length,
      parseErrorCount:      orgParseErrors.length + userParseErrors.length
    }
  });
});

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
  const referenceUserIds = new Set();

  for (const filePath of userFiles) {
    const rows = deviceSearch_parseExcelFile(filePath);
    for (const row of rows) {
      const rowOrgCode = row['Organization Code'] || '';
      const rowOrg = row['Organization'] || '';
      if (
        rowOrgCode === deviceMatch.organizationCode &&
        rowOrg === deviceMatch.organization
      ) {
        const uid = row['User ID'] || '';
        if (uid) referenceUserIds.add(uid);
        matchedUsers.push({
          userId: uid,
          userName: row['User name'] || row['Username'] || '',
          sourceFile: path.relative(__dirname, filePath).replace(/\\/g, '/')
        });
      }
    }
  }

  // --- Enrich device info from bangla index (file3) ---
  const banglaIndex = deviceSearch_buildBanglaIndex();
  const metroRangeSet    = new Set();
  const districtSet      = new Set();
  const policeStationSet = new Set();
  const pollingCenterSet = new Set();
  referenceUserIds.forEach(uid => {
    const meta = banglaIndex.get(uid);
    if (meta) {
      if (meta.metroRange)    metroRangeSet.add(meta.metroRange);
      if (meta.district)      districtSet.add(meta.district);
      if (meta.policeStation) policeStationSet.add(meta.policeStation);
      if (meta.pollingCenter) pollingCenterSet.add(meta.pollingCenter);
    }
  });
  deviceMatch.metroRange    = [...metroRangeSet].join(', ')    || '';
  deviceMatch.district      = [...districtSet].join(', ')      || '';
  deviceMatch.policeStation = [...policeStationSet].join(', ') || '';
  deviceMatch.pollingCenter = [...pollingCenterSet].join(', ') || '';
  deviceMatch.deviceIp      = searchIp;

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

// POST /api/device-csv-breakdown
// Accepts a CSV file (filename = IP address) + runs device search + per-date breakdown
const deviceSearch_csvUpload = multer({
  storage: multer.diskStorage({
    destination: uploadsDir,
    filename: (req, file, cb) => cb(null, `dvcsr-${Date.now()}-${file.originalname}`)
  })
});

app.post('/api/device-csv-breakdown', deviceSearch_csvUpload.single('csvFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No CSV file uploaded.' });

  const ip = (req.body.ip || '').trim();
  if (!ip) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({ success: false, message: 'IP address is required.' });
  }

  // Step 1: Parse CSV rows
  const csvRows = [];
  const stream = fs.createReadStream(req.file.path)
    .pipe(csvParser({ mapHeaders: ({ header }) => header.trim() }));

  stream.on('data', row => csvRows.push(row));
  stream.on('error', err => {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ success: false, message: 'CSV parsing failed: ' + err.message });
  });
  stream.on('end', () => {
    fs.unlink(req.file.path, () => {});

    // Step 2: Build per-date summary from CSV
    const summaryData = generateSummary(csvRows);

    // Step 3: Device search for the IP
    const orgFiles = deviceSearch_getAllExcelFiles(DEVICE_ORG_DIR);
    let deviceMatch = null;
    for (const filePath of orgFiles) {
      const rows = deviceSearch_parseExcelFile(filePath);
      const row = rows.find(r => r['Device IP'] === ip);
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

    // Step 4: Get matched User IDs from user files (reference list)
    const userFiles = deviceSearch_getAllExcelFiles(DEVICE_USER_DIR);
    const referenceUserIds = new Set();
    const matchedUsers = [];

    if (deviceMatch) {
      for (const filePath of userFiles) {
        const rows = deviceSearch_parseExcelFile(filePath);
        for (const row of rows) {
          const rowOrgCode = row['Organization Code'] || '';
          const rowOrg = row['Organization'] || '';
          if (rowOrgCode === deviceMatch.organizationCode && rowOrg === deviceMatch.organization) {
            const uid = row['User ID'] || '';
            if (uid) {
              referenceUserIds.add(uid);
              matchedUsers.push({
                userId: uid,
                sourceFile: path.relative(__dirname, filePath).replace(/\\/g, '/')
              });
            }
          }
        }
      }
    }

    // Step 4b: Build bangla metadata index and enrich device info
    const banglaIndex = deviceSearch_buildBanglaIndex();

    // Collect unique Metro/Range, District, Police Station, Polling Center from matched user IDs
    if (deviceMatch) {
      const metroRangeSet    = new Set();
      const districtSet      = new Set();
      const policeStationSet = new Set();
      const pollingCenterSet = new Set();
      referenceUserIds.forEach(uid => {
        const meta = banglaIndex.get(uid);
        if (meta) {
          if (meta.metroRange)    metroRangeSet.add(meta.metroRange);
          if (meta.district)      districtSet.add(meta.district);
          if (meta.policeStation) policeStationSet.add(meta.policeStation);
          if (meta.pollingCenter) pollingCenterSet.add(meta.pollingCenter);
        }
      });
      deviceMatch.metroRange    = [...metroRangeSet].join(', ')    || '';
      deviceMatch.district      = [...districtSet].join(', ')      || '';
      deviceMatch.policeStation = [...policeStationSet].join(', ') || '';
      deviceMatch.pollingCenter = [...pollingCenterSet].join(', ') || '';
    }

    // Step 5: Per-date breakdown — compare CSV police IDs vs reference user IDs
    const breakdown = summaryData.map(dayData => {
      const csvPoliceIds = new Set(dayData.policeIDs);

      // Found Police IDs = reference IDs that ARE present in the CSV that day
      // This ensures: Found Count + Missing Count = Reference Count
      const foundIds     = [...referenceUserIds].filter(id => csvPoliceIds.has(id)).sort();
      const foundDetails = foundIds.map(id => {
        const meta = banglaIndex.get(id);
        return {
          id,
          detail: meta
            ? `${meta.metroRange} | ${meta.district} | ${meta.policeStation} | ${meta.pollingCenter}`
            : ''
        };
      });

      // Missing Police IDs = reference IDs that did NOT appear in the CSV that day
      const missingIds     = [];
      const missingDetails = [];
      referenceUserIds.forEach(refId => {
        if (!csvPoliceIds.has(refId)) {
          const meta = banglaIndex.get(refId);
          missingIds.push(refId);
          missingDetails.push({
            id: refId,
            detail: meta
              ? `${meta.metroRange} | ${meta.district} | ${meta.policeStation} | ${meta.pollingCenter}`
              : ''
          });
        }
      });
      missingIds.sort();
      missingDetails.sort((a, b) => a.id.localeCompare(b.id));

      const outsiderIds = [...csvPoliceIds].filter(id => id !== '000000' && !referenceUserIds.has(id)).sort();

      const uploadPct  = dayData.totalFiles > 0 ? ((dayData.uploaded    / dayData.totalFiles) * 100).toFixed(1) : '0.0';
      const notUpPct   = dayData.totalFiles > 0 ? ((dayData.notUploaded / dayData.totalFiles) * 100).toFixed(1) : '0.0';

      return {
        date:          dayData.date,
        totalFiles:    dayData.totalFiles,
        uploaded:      dayData.uploaded,
        notUploaded:   dayData.notUploaded,
        uploadPct,
        notUpPct,
        deviceSNCount: dayData.uniqueDeviceSNCount,
        deviceSNs:     dayData.deviceSNs || [],
        referenceCount: referenceUserIds.size,
        uploadedCount:  dayData.uniquePoliceIDCount,
        foundIds,
        foundCount:     foundIds.length,
        foundDetails,
        missingIds,
        missingCount:   missingIds.length,
        missingDetails,
        zeroCount:      dayData.zeroDeviceCount,
        outsiderIds,
        outsiderCount:  outsiderIds.length
      };
    });

    res.json({
      success: true,
      found: !!deviceMatch,
      device: deviceMatch,
      users: matchedUsers,
      breakdown
    });
  });
});

// POST /api/device-breakdown-excel
// Generates an Excel report from the breakdown data sent by the frontend
app.post('/api/device-breakdown-excel', (req, res) => {
  const { device, breakdown } = req.body || {};
  if (!breakdown || !breakdown.length) {
    return res.status(400).json({ success: false, message: 'No breakdown data provided.' });
  }

  const wb   = XLSX.utils.book_new();
  const ws   = {};
  const thin = { style: 'thin', color: { rgb: '000000' } };
  const bord = { top: thin, bottom: thin, left: thin, right: thin };

  // Helpers — NUM_COLS and colCount are set after headers array is defined below

  function setCell(ws, r, c, value, style) {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = { v: value, s: style || {} };
    if (typeof value === 'number') ws[addr].t = 'n';
    else ws[addr].t = 's';
  }

  function headerStyle(bgRgb) {
    return {
      font:      { bold: true },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border:    bord
    };
  }

  function labelStyle() {
    return {
      font:      { bold: true },
      alignment: { vertical: 'center' },
      border:    bord
    };
  }

  function valueStyle(wrap) {
    return {
      alignment: { vertical: 'center', wrapText: !!wrap },
      border:    bord
    };
  }

  function numStyle(bgRgb) {
    return {
      alignment: { horizontal: 'center', vertical: 'center' },
      border:    bord
    };
  }

  const merges = [];
  let R = 0;
  const NUM_COLS = 16; // total columns A–P
  const colCount = NUM_COLS;

  // ── Row 0: "DEVICE INFORMATION" merged header ─────────────────────────────
  setCell(ws, R, 0, 'DEVICE INFORMATION', headerStyle('2563EB'));
  for (let c = 1; c < colCount; c++) setCell(ws, R, c, '', headerStyle('2563EB'));
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: colCount - 1 } });
  R++;

  // ── Rows: Device info key/value pairs ───────────────────────────────────
  const devFields = [
    ['Device IP',         device ? device.deviceIp || ''           : ''],
    ['Device Name',       device ? device.deviceName || ''         : ''],
    ['Organization Code', device ? device.organizationCode || ''   : ''],
    ['Organization',      device ? device.organization || ''       : ''],
    ['Metro/Range',       device ? device.metroRange || ''         : ''],
    ['District',          device ? device.district || ''           : ''],
    ['Police Station',    device ? device.policeStation || ''      : ''],
  ];
  devFields.forEach(([label, val]) => {
    setCell(ws, R, 0, label, labelStyle());
    setCell(ws, R, 1, val,   valueStyle());
    for (let c = 2; c < colCount; c++) setCell(ws, R, c, '', valueStyle());
    merges.push({ s: { r: R, c: 1 }, e: { r: R, c: colCount - 1 } });
    R++;
  });

  // ── Blank row ────────────────────────────────────────────────────────────
  for (let c = 0; c < colCount; c++) setCell(ws, R, c, '', {});
  R++;

  // ── "SUMMARY" merged header ───────────────────────────────────────────────
  setCell(ws, R, 0, 'SUMMARY', headerStyle('2563EB'));
  for (let c = 1; c < colCount; c++) setCell(ws, R, c, '', headerStyle('2563EB'));
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: colCount - 1 } });
  R++;

  // ── Column header row ────────────────────────────────────────────────────
  const headers = [
    'Date', 'Total Files', 'Uploaded', 'Not Uploaded',
    'Uploaded %', 'Not Uploaded %',
    'Reference Count', 'Found Count', 'Missing Count', 'Zero Count', 'Outside Count',
    'Unique Device Count', 'Found Police IDs',
    'Missing Police IDs', 'Outside Police IDs', 'Unique Device SNs'
  ];
  headers.forEach((h, c) => setCell(ws, R, c, h, headerStyle('475569')));
  R++;

  // ── Data rows ─────────────────────────────────────────────────────────────
  breakdown.forEach(row => {
    const snText       = (row.deviceSNs    || []).join(', ');
    const foundText    = (row.foundIds     || []).join(', ');
    const missingText  = (row.missingIds   || []).join(', ');
    const outsideText  = (row.outsiderIds  || []).join(', ');

    setCell(ws, R, 0,  row.date,                   { font: { bold: true }, alignment: { vertical: 'center' }, border: bord });
    setCell(ws, R, 1,  row.totalFiles,              numStyle());
    setCell(ws, R, 2,  row.uploaded,                numStyle());
    setCell(ws, R, 3,  row.notUploaded,             numStyle());
    setCell(ws, R, 4,  row.uploadPct + '%',         numStyle());
    setCell(ws, R, 5,  row.notUpPct  + '%',         numStyle());
    setCell(ws, R, 6,  row.referenceCount,          numStyle());
    setCell(ws, R, 7,  row.foundCount,              numStyle());
    setCell(ws, R, 8,  row.missingCount,            numStyle());
    setCell(ws, R, 9,  row.zeroCount || 0,          numStyle());
    setCell(ws, R, 10, row.outsiderCount || 0,      numStyle());
    setCell(ws, R, 11, row.deviceSNCount,           numStyle());
    setCell(ws, R, 12, foundText,                   { alignment: { vertical: 'top', wrapText: true }, border: bord });
    setCell(ws, R, 13, missingText,                 { alignment: { vertical: 'top', wrapText: true }, border: bord });
    setCell(ws, R, 14, outsideText,                 { alignment: { vertical: 'top', wrapText: true }, border: bord });
    setCell(ws, R, 15, snText,                      { alignment: { vertical: 'top', wrapText: true }, border: bord });
    R++;
  });

  // ── Set worksheet ref and properties ──────────────────────────────────────
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: colCount - 1 } });
  ws['!merges'] = merges;
  ws['!cols'] = [
    { wch: 14 }, { wch: 12 }, { wch: 11 }, { wch: 13 },
    { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 13 },
    { wch: 14 }, { wch: 12 }, { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 28 }, { wch: 28 }, { wch: 30 }
  ];
  // Set row heights for data rows to accommodate wrapped IDs
  ws['!rows'] = [];
  for (let i = 0; i < R; i++) ws['!rows'].push({ hpt: 18 });

  XLSX.utils.book_append_sheet(wb, ws, 'Breakdown Report');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  // Filename: MetroRange-District-PoliceStation-DeviceName-Organization-IP.xlsx
  // Bengali fields kept as-is in the Unicode filename (RFC 5987 encoding for the header)
  const safeSegment = (s) => String(s || '')
    .replace(/[/\\?%*:|"<>]/g, '-')   // remove chars invalid in filenames
    .replace(/\s+/g, ' ')
    .trim();
  const fnMetro   = safeSegment(device ? device.metroRange    : '');
  const fnDistr   = safeSegment(device ? device.district      : '');
  const fnPolice  = safeSegment(device ? device.policeStation : '');
  const fnDev     = safeSegment(device ? device.deviceName    : 'Device');
  const fnOrg     = safeSegment(device ? device.organization  : 'Org');
  const fnIp      = safeSegment(device ? device.deviceIp      : 'IP');
  const filenameParts = [fnMetro, fnDistr, fnPolice, fnDev, fnOrg, fnIp].filter(Boolean);
  const filename      = `${filenameParts.join('-')}.xlsx`;

  // ASCII fallback for older clients; filename* carries the full Unicode name
  const filenameAscii = filename.replace(/[^\x20-\x7E]/g, '_');

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',
    `attachment; filename="${filenameAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buffer);
});

// POST /api/device-scan-duplicate-userids-excel
// Generates an Excel report of all duplicate User IDs found in user files
app.post('/api/device-scan-duplicate-userids-excel', (req, res) => {
  const { duplicateUserIds } = req.body || {};
  if (!duplicateUserIds || !duplicateUserIds.length) {
    return res.status(400).json({ success: false, message: 'No duplicate User ID data provided.' });
  }

  const wb   = XLSX.utils.book_new();
  const ws   = {};
  const thin = { style: 'thin', color: { rgb: '000000' } };
  const bord = { top: thin, bottom: thin, left: thin, right: thin };

  function setCell(r, c, value, style) {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = { v: value, s: style || {}, t: typeof value === 'number' ? 'n' : 's' };
  }

  const hdrStyle = {
    font: { bold: true },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: bord
  };
  const labelStyle = { font: { bold: true }, alignment: { vertical: 'center' }, border: bord };
  const cellStyle  = { alignment: { vertical: 'center', wrapText: true }, border: bord };
  const numStyle   = { alignment: { horizontal: 'center', vertical: 'center' }, border: bord };

  let R = 0;
  const NUM_COLS = 4;

  // ── Title row ─────────────────────────────────────────────────────────────
  setCell(R, 0, 'DUPLICATE USER IDs REPORT', hdrStyle);
  for (let c = 1; c < NUM_COLS; c++) setCell(R, c, '', hdrStyle);
  const merges = [{ s: { r: R, c: 0 }, e: { r: R, c: NUM_COLS - 1 } }];
  R++;

  // ── Sub-header: scan date ─────────────────────────────────────────────────
  const scanDate = new Date().toLocaleString();
  setCell(R, 0, `Scanned: ${scanDate}`, { alignment: { vertical: 'center' }, border: bord });
  for (let c = 1; c < NUM_COLS; c++) setCell(R, c, '', { border: bord });
  merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NUM_COLS - 1 } });
  R++;

  // ── Blank row ─────────────────────────────────────────────────────────────
  for (let c = 0; c < NUM_COLS; c++) setCell(R, c, '', {});
  R++;

  // ── Column headers ────────────────────────────────────────────────────────
  ['User ID', 'Found In (Files)', 'Org Code', 'Organization'].forEach((h, c) => setCell(R, c, h, hdrStyle));
  R++;

  // ── Data rows ─────────────────────────────────────────────────────────────
  duplicateUserIds.forEach(({ userId, entries }) => {
    const files = entries.map(e => e.sourceFile.replace(/^file\/user\//i, '')).join('\n');
    const codes = entries.map(e => e.orgCode).join('\n');
    const orgs  = entries.map(e => e.organization).join('\n');
    setCell(R, 0, userId,        labelStyle);
    setCell(R, 1, files,         { ...cellStyle, alignment: { vertical: 'top', wrapText: true }, border: bord });
    setCell(R, 2, codes,         { ...cellStyle, alignment: { vertical: 'top', wrapText: true }, border: bord });
    setCell(R, 3, orgs,          { ...cellStyle, alignment: { vertical: 'top', wrapText: true }, border: bord });
    R++;
  });

  ws['!ref']    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: NUM_COLS - 1 } });
  ws['!merges'] = merges;
  ws['!cols']   = [{ wch: 18 }, { wch: 55 }, { wch: 14 }, { wch: 22 }];
  ws['!rows']   = Array.from({ length: R }, () => ({ hpt: 18 }));

  XLSX.utils.book_append_sheet(wb, ws, 'Duplicate User IDs');
  const buffer   = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const dateStr  = new Date().toISOString().split('T')[0];
  const filename = `Duplicate-UserIDs-${dateStr}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ============================================================
// START: User Location Report Feature
// ============================================================

// POST /api/user-location-report
// Accepts { users: [{id, uploaded}] }
// Returns grouped data: Metro/Range → District → Police Station → { uploadedIds, notUploadedIds }
app.post('/api/user-location-report', (req, res) => {
  const { users } = req.body || {};
  if (!Array.isArray(users) || !users.length) {
    return res.status(400).json({ success: false, message: 'No user data provided.' });
  }

  // ── Build bangla lookup structures ─────────────────────────────────────────
  const idIndex     = new Map(); // ID         → { metro, district, policeStation }
  const cameraIndex = new Map(); // Camera Name → { metro, district, policeStation }

  const banglaFiles = deviceSearch_getAllExcelFiles(DEVICE_BANGLA_DIR);
  for (const filePath of banglaFiles) {
    let rows;
    try { rows = deviceSearch_parseExcelFile(filePath); } catch (e) { continue; }
    for (const row of rows) {
      const meta = {
        metro:        row['Metro/Range'] || row['Metro'] || '',
        district:     row['District']    || '',
        policeStation: row['Police Station'] || ''
      };
      const id  = row['ID'] || '';
      const cam = row['Camera Name'] || row['Final_Code'] || '';
      if (id  && !idIndex.has(id))       idIndex.set(id, meta);
      if (cam && !cameraIndex.has(cam))  cameraIndex.set(cam, meta);
    }
  }

  // ── Build prefix index: "PREFIX-ORG" → first matching meta ─────────────────
  // e.g. "CHT-SAT" → meta from first Camera Name starting with "CHT-SAT-"
  const prefixIndex = new Map();
  cameraIndex.forEach((meta, cam) => {
    const parts = cam.split('-');
    if (parts.length >= 2) {
      const prefix = parts[0] + '-' + parts[1]; // e.g. "CHT-SAT"
      if (!prefixIndex.has(prefix)) prefixIndex.set(prefix, meta);
    }
  });

  // ── Resolve each user via 3-layer lookup ───────────────────────────────────
  function resolveMeta(id, name) {
    // Layer 1: direct ID match in bangla
    if (idIndex.has(id)) return idIndex.get(id);

    // Layer 2: User name* exact match against Camera Name
    if (name && cameraIndex.has(name)) return cameraIndex.get(name);

    // Layer 3: User name* prefix match (e.g. "CHT-SAT-NCK" → prefix "CHT-SAT")
    if (name) {
      const parts = name.split('-');
      if (parts.length >= 2) {
        const prefix = parts[0] + '-' + parts[1];
        if (prefixIndex.has(prefix)) return prefixIndex.get(prefix);
      }
    }

    return null;
  }

  // ── Group by Metro/Range → District → Police Station ──────────────────────
  const grouped      = new Map();
  const unmatched    = { uploaded: [], notUploaded: [] };
  const submittedIds   = new Set(users.map(u => u.id));
  // User ID* may be numeric — also track by User name* (camera-style) to match
  // alphanumeric User IDs in file/user/ (e.g. SMAIA1 matches via SMP-AIR-AGS1 name)
  const submittedNames = new Set(users.map(u => u.name).filter(Boolean));

  function addToBucket(metro, dist, ps, field, id) {
    if (!grouped.has(metro)) grouped.set(metro, new Map());
    const metroMap = grouped.get(metro);
    if (!metroMap.has(dist)) metroMap.set(dist, new Map());
    const distMap = metroMap.get(dist);
    if (!distMap.has(ps)) distMap.set(ps, { uploaded: [], notUploaded: [], notInExcel: [] });
    distMap.get(ps)[field].push(id);
  }

  for (const { id, name, uploaded } of users) {
    const meta = resolveMeta(id, name || '');
    if (!meta || (!meta.metro && !meta.district && !meta.policeStation)) {
      if (uploaded) unmatched.uploaded.push(id);
      else          unmatched.notUploaded.push(id);
      continue;
    }
    const metro = meta.metro         || '(Unknown Range)';
    const dist  = meta.district      || '(Unknown District)';
    const ps    = meta.policeStation || '(Unknown Police Station)';
    addToBucket(metro, dist, ps, uploaded ? 'uploaded' : 'notUploaded', id);
  }

  // ── Add "Not In Excel" IDs from file/user/ that aren't in the submitted set ─
  const userFiles2 = deviceSearch_getAllExcelFiles(DEVICE_USER_DIR);
  const seenNotInExcel = new Set(); // avoid duplicates across files
  for (const filePath of userFiles2) {
    let rows;
    try { rows = deviceSearch_parseExcelFile(filePath); } catch (e) { continue; }
    for (const row of rows) {
      const userId   = String(row['User ID']   || '').trim();
      const userName = String(row['User name'] || '').trim();
      if (!userId || submittedIds.has(userId) || submittedNames.has(userName) || seenNotInExcel.has(userId)) continue;
      seenNotInExcel.add(userId);
      const meta = resolveMeta(userId, userName);
      if (!meta || (!meta.metro && !meta.district && !meta.policeStation)) continue;
      const metro = meta.metro         || '(Unknown Range)';
      const dist  = meta.district      || '(Unknown District)';
      const ps    = meta.policeStation || '(Unknown Police Station)';
      addToBucket(metro, dist, ps, 'notInExcel', userId);
    }
  }

  // ── Serialise ──────────────────────────────────────────────────────────────
  const report = [];
  grouped.forEach((metroMap, metro) => {
    metroMap.forEach((distMap, district) => {
      distMap.forEach((bucket, policeStation) => {
        bucket.uploaded.sort();
        bucket.notUploaded.sort();
        bucket.notInExcel.sort();
        report.push({
          metro,
          district,
          policeStation,
          uploadedIds:      bucket.uploaded,
          notUploadedIds:   bucket.notUploaded,
          notInExcelIds:    bucket.notInExcel,
          uploadedCount:    bucket.uploaded.length,
          notUploadedCount: bucket.notUploaded.length,
          notInExcelCount:  bucket.notInExcel.length
        });
      });
    });
  });

  report.sort((a, b) =>
    a.metro.localeCompare(b.metro) ||
    a.district.localeCompare(b.district) ||
    a.policeStation.localeCompare(b.policeStation)
  );

  res.json({ success: true, report, unmatched });
});

// POST /api/user-location-report-excel
// Accepts { report, unmatched } (same structure returned by /api/user-location-report)
// Returns an xlsx file matching the screenshot format
app.post('/api/user-location-report-excel', (req, res) => {
  const { report, unmatched } = req.body || {};
  if (!report || !report.length) {
    return res.status(400).json({ success: false, message: 'No report data provided.' });
  }

  const wb   = XLSX.utils.book_new();
  const ws   = {};
  const thin = { style: 'thin', color: { rgb: '000000' } };
  const bord = { top: thin, bottom: thin, left: thin, right: thin };
  const merges = [];
  const NUM_COLS = 4;
  let R = 0;

  function sc(r, c, v, s) {
    const addr = XLSX.utils.encode_cell({ r, c });
    ws[addr] = { v, s: s || {}, t: typeof v === 'number' ? 'n' : 's' };
  }

  const hdrStyle = {
    font: { bold: true, color: { rgb: 'FFFFFF' } },
    fill: { fgColor: { rgb: '1E3A5F' } },
    alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    border: bord
  };
  const subHdrStyle = {
    font: { bold: true },
    fill: { fgColor: { rgb: 'D9E1F2' } },
    alignment: { horizontal: 'center', vertical: 'center' },
    border: bord
  };
  const labelStyle = { font: { bold: true }, alignment: { vertical: 'center' }, border: bord };
  const cellStyle  = { alignment: { vertical: 'top', wrapText: true }, border: bord };
  const numStyle   = { alignment: { horizontal: 'center', vertical: 'center' }, border: bord };

  function mergeRow(r, text, style) {
    sc(r, 0, text, style);
    for (let c = 1; c < NUM_COLS; c++) sc(r, c, '', style);
    merges.push({ s: { r, c: 0 }, e: { r, c: NUM_COLS - 1 } });
  }

  // ── Title ────────────────────────────────────────────────────────────────
  mergeRow(R, 'USER UPLOAD STATUS REPORT', hdrStyle); R++;
  mergeRow(R, `Generated: ${new Date().toLocaleString()}`, {
    alignment: { horizontal: 'center' }, border: bord
  }); R++;
  // Blank
  mergeRow(R, '', {}); R++;

  // ── Column headers ────────────────────────────────────────────────────────
  ['Metro/Range', 'District', 'Police Station', 'Upload Summary'].forEach((h, c) => sc(R, c, h, hdrStyle));
  R++;

  // Group rows by metro for merged cells
  // We need to compute spans first
  const metroSpans   = new Map(); // metro → count of PS rows
  const distSpans    = new Map(); // "metro|dist" → count of PS rows
  report.forEach(row => {
    metroSpans.set(row.metro, (metroSpans.get(row.metro) || 0) + 1);
    const dk = `${row.metro}|${row.district}`;
    distSpans.set(dk, (distSpans.get(dk) || 0) + 1);
  });

  // Track start rows for merging
  const metroStart = new Map();
  const distStart  = new Map();

  report.forEach((row, idx) => {
    const startR = R;
    const dk = `${row.metro}|${row.district}`;

    if (!metroStart.has(row.metro)) metroStart.set(row.metro, R);
    if (!distStart.has(dk))         distStart.set(dk, R);

    const upText  = row.uploadedIds.join(', ')                 || '-';
    const notText = row.notUploadedIds.join(', ')              || '-';
    const nieText = (row.notInExcelIds || []).join(', ')        || '-';
    const summary = `✅ Uploaded (${row.uploadedCount}): ${upText}\n\n❌ Not Uploaded (${row.notUploadedCount}): ${notText}\n\n⬜ Not In Excel (${row.notInExcelCount || 0}): ${nieText}`;

    // Metro/Range cell — will be merged after loop
    sc(R, 0, row.metro,        labelStyle);
    sc(R, 1, row.district,     labelStyle);
    sc(R, 2, row.policeStation, { alignment: { vertical: 'center' }, border: bord });
    sc(R, 3, summary, { ...cellStyle, alignment: { vertical: 'top', wrapText: true }, border: bord });
    R++;
  });

  // Apply merges for metro and district spans
  report.forEach(row => {
    const dk = `${row.metro}|${row.district}`;
    // Metro merge
    if (metroSpans.get(row.metro) > 1 && metroStart.has(row.metro)) {
      const s = metroStart.get(row.metro);
      const span = metroSpans.get(row.metro);
      if (span > 1) merges.push({ s: { r: s, c: 0 }, e: { r: s + span - 1, c: 0 } });
      metroStart.delete(row.metro); // only add once
    }
    // District merge
    if (distSpans.get(dk) > 1 && distStart.has(dk)) {
      const s = distStart.get(dk);
      const span = distSpans.get(dk);
      if (span > 1) merges.push({ s: { r: s, c: 1 }, e: { r: s + span - 1, c: 1 } });
      distStart.delete(dk);
    }
  });

  // ── Unmatched section (IDs not found in bangla index) ────────────────────
  if ((unmatched.uploaded.length + unmatched.notUploaded.length) > 0) {
    mergeRow(R, '', {}); R++;
    mergeRow(R, 'UNMATCHED USER IDs (not found in location index)', {
      font: { bold: true }, fill: { fgColor: { rgb: 'FFF3CD' } },
      alignment: { horizontal: 'center' }, border: bord
    }); R++;
    const um = `✅ Uploaded (${unmatched.uploaded.length}): ${unmatched.uploaded.join(', ') || '-'}\n\n❌ Not Uploaded (${unmatched.notUploaded.length}): ${unmatched.notUploaded.join(', ') || '-'}`;
    sc(R, 0, um, cellStyle);
    for (let c = 1; c < NUM_COLS; c++) sc(R, c, '', cellStyle);
    merges.push({ s: { r: R, c: 0 }, e: { r: R, c: NUM_COLS - 1 } });
    R++;
  }

  ws['!ref']    = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: R - 1, c: NUM_COLS - 1 } });
  ws['!merges'] = merges;
  ws['!cols']   = [{ wch: 20 }, { wch: 22 }, { wch: 24 }, { wch: 80 }];
  ws['!rows']   = Array.from({ length: R }, (_, i) => i >= 4 ? { hpt: 60 } : { hpt: 20 });

  XLSX.utils.book_append_sheet(wb, ws, 'Upload Status Report');
  const buffer   = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const dateStr  = new Date().toISOString().split('T')[0];
  const filename = `User-Upload-Status-${dateStr}.xlsx`;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// ============================================================
// END: User Location Report Feature
// ============================================================

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