/* Dr-Diary — spreadsheet import (xlsx/xls/csv/json) and export. */
(function (DD) {
  'use strict';

  var P = DD.parse;
  var S = DD.store;

  var FIELDS = [
    { key: 'name', label: 'Name', required: true },
    { key: 'type', label: 'Type (doctor/medical/distributor)' },
    { key: 'hospital', label: 'Hospital / clinic' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'area', label: 'Area' },
    { key: 'day', label: 'Day' },
    { key: 'time', label: 'Time' },
    { key: 'speciality', label: 'Speciality' },
    { key: 'category', label: 'Category' },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State' },
    { key: 'notes', label: 'Notes' }
  ];

  // primary wins over fallback regardless of column order, so a sheet with both
  // ClinicTel and MOBILENO maps mobile to MOBILENO.
  var ALIASES = {
    name: { primary: ['dr name', 'doctor name', 'drname', 'doctorname'], fallback: ['name', 'party name', 'firm name', 'shop name'] },
    type: { primary: ['type', 'party type', 'contact type', 'category type'], fallback: [] },
    hospital: { primary: ['hospital name', 'hospital', 'clinic name', 'hospitalname'], fallback: ['clinic', 'address1'] },
    mobile: { primary: ['mobile no', 'mobile', 'mobileno', 'mobile number'], fallback: ['phone', 'contact', 'contact no', 'clinictel'] },
    area: { primary: ['area', 'market name', 'marketname'], fallback: ['location', 'locality'] },
    day: { primary: ['day', 'best day', 'bestday', 'visit day', 'days'], fallback: [] },
    time: { primary: ['time', 'best time', 'besttime', 'visit time'], fallback: [] },
    speciality: { primary: ['specialisation', 'specialization', 'speciality', 'specialty'], fallback: [] },
    category: { primary: ['category', 'customer category'], fallback: ['classname', 'class'] },
    city: { primary: ['city'], fallback: ['town'] },
    state: { primary: ['state'], fallback: [] },
    notes: { primary: ['notes', 'note', 'remark', 'remarks'], fallback: [] }
  };

  function norm(s) {
    return String(s === null || s === undefined ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function autoMap(headers) {
    var map = {};
    var normed = headers.map(norm);
    ['primary', 'fallback'].forEach(function (tier) {
      normed.forEach(function (n, i) {
        if (!n) return;
        for (var key in ALIASES) {
          if (map[key] !== undefined) continue;
          if (ALIASES[key][tier].indexOf(n) !== -1) { map[key] = i; return; }
        }
      });
    });
    return map;
  }

  /** The header row is not always row 1 — CRM exports put a title above it. */
  function findHeaderRow(rows) {
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var m = autoMap(rows[i].map(function (c) { return P.clean(c); }));
      if (m.name !== undefined) return { index: i, map: m };
    }
    return null;
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read the file.')); };

      if (/\.json$/i.test(file.name)) {
        reader.onload = function () {
          try {
            var parsed = JSON.parse(reader.result);
            var docs = Array.isArray(parsed) ? parsed : parsed.doctors;
            if (!Array.isArray(docs)) throw new Error('No "doctors" array found in the JSON.');
            resolve({ kind: 'json', doctors: docs, photos: parsed && parsed.photos });
          } catch (e) { reject(e); }
        };
        reader.readAsText(file);
        return;
      }

      reader.onload = function () {
        try {
          if (typeof XLSX === 'undefined') throw new Error('The Excel reader did not load.');
          var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
          var ws = wb.Sheets[wb.SheetNames[0]];
          var rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
          if (!rows.length) throw new Error('The sheet is empty.');
          resolve({ kind: 'sheet', rows: rows, sheetName: wb.SheetNames[0] });
        } catch (e) { reject(e); }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** Turn sheet rows + a column map into normalised doctor objects. */
  function buildDoctors(rows, headerIndex, map) {
    var out = [];
    var pick = function (row, key) { return map[key] === undefined ? '' : row[map[key]]; };

    for (var i = headerIndex + 1; i < rows.length; i++) {
      var row = rows[i];
      var name = P.clean(pick(row, 'name'));
      if (!name) continue;

      var days = P.parseDays(pick(row, 'day'));
      var time = P.parseTime(pick(row, 'time'));

      out.push({
        id: S.nextId(),
        type: DD.store.normaliseType(pick(row, 'type')) || 'doctor',
        name: name.toUpperCase(),
        hospital: P.clean(pick(row, 'hospital')),
        mobile: P.parseMobile(pick(row, 'mobile')),
        area: P.clean(pick(row, 'area')).toUpperCase(),
        city: P.clean(pick(row, 'city')).toUpperCase(),
        state: P.clean(pick(row, 'state')).toUpperCase(),
        speciality: P.clean(pick(row, 'speciality')) || 'Orthopaedic',
        category: P.clean(pick(row, 'category')),
        slots: days.map(function (day) { return { day: day, time: time, place: '' }; }),
        notes: P.clean(pick(row, 'notes')),
        visits: [],
        updatedAt: Date.now()
      });
    }
    return out;
  }

  /* ---------- exports ---------- */

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function stamp() { return P.isoDate().replace(/-/g, ''); }

  function exportJSON() {
    download(new Blob([S.exportJSON()], { type: 'application/json' }), 'dr-diary-backup-' + stamp() + '.json');
  }

  /**
   * Same JSON plus every visiting card inlined as a data URL. Much larger than
   * the plain backup — base64 adds ~33% on top of the images — but it is the
   * only copy that survives changing phones.
   */
  function exportFullBackup() {
    var PH = DD.photos;
    var payload = JSON.parse(S.exportJSON());
    return PH.keys().then(function (ids) {
      return Promise.all(ids.map(function (id) {
        return PH.get(id).then(function (blob) {
          return blob ? PH.blobToDataURL(blob).then(function (u) { return [id, u]; }) : null;
        });
      }));
    }).then(function (pairs) {
      payload.photos = {};
      pairs.filter(Boolean).forEach(function (p) { payload.photos[p[0]] = p[1]; });
      var count = Object.keys(payload.photos).length;
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      download(blob, 'dr-diary-full-backup-' + stamp() + '.json');
      return { count: count, bytes: blob.size };
    });
  }

  /**
   * Restore card images that came in with a full backup.
   * @param photos {oldDoctorId: dataURL}
   * @param idMap  from store.importDoctors — the backup's ids are not the ids
   *               the doctors ended up with, so every photo has to be re-keyed.
   */
  function restorePhotos(photos, idMap) {
    var PH = DD.photos;
    var S = DD.store;
    if (!photos || typeof photos !== 'object') return Promise.resolve(0);

    var saved = 0;
    return Promise.all(Object.keys(photos).map(function (oldId) {
      var newId = (idMap && idMap[oldId]) || oldId;
      if (!S.get(newId)) return Promise.resolve(); // doctor did not survive the import
      try {
        return PH.put(newId, PH.dataURLToBlob(photos[oldId])).then(function () {
          S.setCard(newId, true);
          saved++;
        });
      } catch (e) {
        return Promise.resolve();
      }
    })).then(function () { return saved; });
  }

  /** One row per doctor; multiple slots collapse into comma-joined columns. */
  function exportXLSX() {
    if (typeof XLSX === 'undefined') { alert('The Excel writer did not load.'); return; }
    var rows = [['TYPE', 'DR NAME', 'HOSPITAL NAME', 'MOBILE NO', 'AREA', 'DAY', 'TIME', 'PLACE',
                 'SPECIALITY', 'CATEGORY', 'CITY', 'STATE', 'NOTES', 'LAST VISIT', 'TOTAL VISITS']];
    S.all().forEach(function (d) {
      var last = S.lastVisit(d);
      rows.push([
        (S.TYPES[d.type] || S.TYPES.doctor).label, d.name, d.hospital, d.mobile, d.area,
        d.slots.map(function (s) { return P.DAY_LABEL[s.day]; }).join(', '),
        d.slots.map(function (s) { return P.formatTime(s.time); }).join(', '),
        d.slots.map(function (s) { return s.place; }).filter(Boolean).join(', '),
        d.speciality, d.category, d.city, d.state, d.notes,
        last ? last.date : '', d.visits.length
      ]);
    });
    var ws = XLSX.utils.aoa_to_sheet(rows);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Doctors');
    var buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
             'dr-diary-' + stamp() + '.xlsx');
  }

  DD.io = {
    FIELDS: FIELDS,
    autoMap: autoMap,
    findHeaderRow: findHeaderRow,
    readFile: readFile,
    buildDoctors: buildDoctors,
    download: download,
    exportJSON: exportJSON,
    exportFullBackup: exportFullBackup,
    restorePhotos: restorePhotos,
    exportXLSX: exportXLSX
  };
})(window.DD = window.DD || {});
