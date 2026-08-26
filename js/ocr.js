/* Dr-Diary — read a visiting card and fill the doctor form.
   Tesseract runs entirely on the device: nothing about a doctor is uploaded.
   The engine is loaded on first use, not at startup, so the app stays light
   for anyone who never scans a card. */
(function (DD) {
  'use strict';

  var P = DD.parse;
  var TL = DD.translit;

  var BASE = 'vendor/tesseract/';
  /* English only. Loading Hindi and Gujarati alongside it makes Tesseract
     weigh three scripts for every character, and it guesses wrong often enough
     that English lines come back as noise — the exact problem that made scans
     unreliable. Indian medical visiting cards are printed in English almost
     without exception, so this is both more accurate and a smaller download.
     DD.translit still converts any Devanagari/Gujarati that a card does carry. */
  var LANGS = 'eng';

  var workerPromise = null;
  var scriptPromise = null;

  /* ---------- engine loading ---------- */

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('The card reader did not load: ' + src)); };
      document.head.appendChild(s);
    });
  }

  /** wasm SIMD is in every browser since 2021, but fall back rather than fail. */
  function hasSimd() {
    try {
      return WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3,
        2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11
      ]));
    } catch (e) {
      return false;
    }
  }

  function ensureScript() {
    if (!scriptPromise) scriptPromise = loadScript(BASE + 'tesseract.min.js');
    return scriptPromise;
  }

  /**
   * @param onProgress called with {status, progress} — the first run downloads
   *        ~9 MB of engine and language data, so the UI must show something.
   */
  function getWorker(onProgress) {
    if (workerPromise) return workerPromise;

    workerPromise = ensureScript().then(function () {
      if (typeof Tesseract === 'undefined') throw new Error('The card reader did not load');
      return Tesseract.createWorker(LANGS, 1, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + (hasSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js'),
        langPath: BASE + 'tessdata',
        // Plain .traineddata, not .gz: a CDN that labels a .gz file with
        // Content-Encoding: gzip makes the browser decompress it first, and
        // Tesseract then fails trying to gunzip already-plain bytes. Hosts
        // compress it in transit anyway, so the download stays the same size.
        gzip: false,
        logger: function (m) { if (onProgress) onProgress(m); }
      });
    }).catch(function (err) {
      workerPromise = null; // let the next attempt retry a failed download
      throw err;
    });

    return workerPromise;
  }

  /* ---------- recognition ---------- */

  /**
   * @param source the ORIGINAL picked file where possible — the stored copy is
   *        compressed for space and its JPEG artefacts hurt recognition.
   */
  function recognize(source, onProgress) {
    var prepared = DD.photos && DD.photos.prepareForOcr
      ? DD.photos.prepareForOcr(source).catch(function () { return source; })
      : Promise.resolve(source);

    return Promise.all([getWorker(onProgress), prepared]).then(function (r) {
      var worker = r[0], img = r[1];
      // Without a DPI hint Tesseract assumes 70 and mis-sizes the text.
      // psm 12 = sparse text with orientation detection. A visiting card is
      // scattered blocks at different sizes, not a page of prose; the default
      // (full layout analysis) reads a tilted card as nothing at all, while
      // this finds the lines and is several times faster.
      return worker.setParameters({ tessedit_pageseg_mode: '12', user_defined_dpi: '300' })
        .catch(function () {})
        .then(function () { return worker.recognize(img); });
    }).then(function (res) {
      return (res && res.data && res.data.text) || '';
    });
  }

  /* ---------- field extraction ---------- */

  /** Indic digits first, so "૯૮૨૫૧૩૦૫૦૬" is findable as a phone number. */
  function asciiDigits(s) {
    return String(s || '')
      .replace(/[०-९]/g, function (c) { return String(c.charCodeAt(0) - 0x0966); })
      .replace(/[૦-૯]/g, function (c) { return String(c.charCodeAt(0) - 0x0AE6); });
  }

  var DOCTOR_MARK = /(^|\s)(dr|dr\.|doctor|do\.?|डॉ|डा|ડૉ|ડા)(\s|\.|$)/i;

  /* A card usually carries both "Orthopaedic Surgeon" (the speciality) and
     "Vikas Orthopaedic Clinic" (the place). Matching on "ortho" alone picks the
     wrong one, so look for a place noun first and only fall back to the weaker
     hints if the card has none. */
  var CLINIC_STRONG = /(hospital|hospitl|haspital|clinic|klinik|kalinik|nursing\s*home|polyclinic|dawakhana|centre|center|sentar)/i;
  var CLINIC_WEAK = /(ortho|orthopa|care|medical|medikal|institute|healthcare)/i;
  var CLINIC_WORDS = /(hospital|hospitl|clinic|klinik|ortho|orthopa|nursing|centre|center|sentar|care|medical|medikal|polyclinic|dawakhana)/i;
  /* Lines that describe the person, not a place. */
  var ROLE_ONLY = /(surgeon|surjan|sarjan|physician|consultant|specialist|special ist)/i;
  var SPECIALITY_WORDS = /(orthopa|orthoped|ortho|joint|knee|spine|trauma|arthro|fracture|haddi|bone)/i;
  var DEGREE_LINE = /\b(m\.?b\.?b\.?s|m\.?s\.?|m\.?d\.?|d\.?n\.?b|f\.?r\.?c\.?s|d\.?ortho|mch)\b/i;
  var JUNK_LINE = /^(tel|ph|phone|mob|mobile|email|e-?mail|www|timing|time|consult)/i;

  /**
   * Indian mobiles are 10 digits starting 6-9. Cards print them with +91,
   * spaces, dots and dashes, and often list a landline too — prefer the
   * mobile-shaped one.
   */
  function findMobiles(text) {
    var t = asciiDigits(text);
    var out = [];
    // Spaces and dashes are allowed inside a number, newlines are not: a pincode
    // on one line must not merge with the mobile on the next.
    var re = /(?:\+?9[ \t]*1[ \t\-.]*)?([6-9][\d \t\-.]{9,14})/g;
    var m;
    while ((m = re.exec(t)) !== null) {
      // A digit immediately before the match means we started mid-number — an
      // STD landline like "079-27541234" would otherwise read as "7927541234".
      var prev = t[m.index - 1];
      if (prev && /\d/.test(prev)) {
        // Resume one character on, or the real number that follows gets skipped.
        re.lastIndex = m.index + 1;
        continue;
      }

      var digits = m[1].replace(/\D/g, '');
      if (digits.length > 10) digits = digits.slice(0, 10);
      if (digits.length !== 10) continue;
      if (!/^[6-9]/.test(digits)) continue;
      var distinct = {};
      for (var i = 0; i < 10; i++) distinct[digits[i]] = 1;
      if (Object.keys(distinct).length < 4) continue;
      if (out.indexOf(digits) === -1) out.push(digits);
    }
    return out;
  }

  function titleCaseWords(s) {
    return String(s || '').toLowerCase().replace(/\b([a-z])/g, function (_, c) {
      return c.toUpperCase();
    });
  }

  /**
   * @param text  raw OCR output, any script
   * @param areas known area names (from the user's own data) — matching against
   *              these is far more reliable than guessing an address line
   * @returns {{name, mobile, hospital, area, speciality, raw, lines}}
   */
  function extract(text, areas) {
    var rawLines = String(text || '').split(/\r?\n/)
      .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
      .filter(function (l) { return l.length > 1; });

    // Keep both scripts: the original for area matching, English for the form.
    var lines = rawLines.map(function (l) {
      return { raw: l, en: TL.toEnglish(l) };
    });

    var out = { name: '', mobile: '', hospital: '', area: '', speciality: '', raw: text, lines: rawLines };

    /* name — a line carrying a doctor marker wins; otherwise the first line
       that is not a phone number, degree list or contact label. */
    var nameLine = null;
    for (var i = 0; i < lines.length; i++) {
      if (DOCTOR_MARK.test(lines[i].raw) || DOCTOR_MARK.test(lines[i].en)) { nameLine = lines[i]; break; }
    }
    if (!nameLine) {
      for (var j = 0; j < lines.length; j++) {
        var e = lines[j].en;
        if (JUNK_LINE.test(e)) continue;
        if (DEGREE_LINE.test(e)) continue;
        if (CLINIC_WORDS.test(e)) continue;
        if (findMobiles(lines[j].raw).length) continue;
        if (!/[A-Za-z]{3}/.test(e)) continue;
        nameLine = lines[j];
        break;
      }
    }
    if (nameLine) {
      // Strip any degrees trailing the name on the same line.
      var namePart = nameLine.en.split(/[,|]/)[0];
      out.name = TL.cleanName(namePart);
    }

    /* mobile */
    var mobiles = findMobiles(text);
    if (mobiles.length) out.mobile = mobiles.slice(0, 2).join(', ');

    /* hospital / clinic — a place noun beats a job title */
    var pickClinic = function (test) {
      for (var k = 0; k < lines.length; k++) {
        if (nameLine && lines[k] === nameLine) continue;
        var en = lines[k].en;
        if (!test.test(en)) continue;
        // "Orthopaedic Surgeon" is what the doctor is, not where they sit.
        if (ROLE_ONLY.test(en) && !CLINIC_STRONG.test(en)) continue;
        if (findMobiles(lines[k].raw).length) continue;
        return titleCaseWords(en.replace(/[^A-Za-z0-9 .,&'-]/g, '').trim());
      }
      return '';
    };
    out.hospital = pickClinic(CLINIC_STRONG) || pickClinic(CLINIC_WEAK);

    /* speciality */
    for (var s = 0; s < lines.length; s++) {
      if (SPECIALITY_WORDS.test(lines[s].en)) { out.speciality = 'Orthopaedic'; break; }
    }

    /* area — match the card against areas already in the diary */
    var haystack = P.searchKey(lines.map(function (l) { return l.en; }).join(' '));
    var best = '';
    (areas || []).forEach(function (a) {
      var key = P.searchKey(a);
      if (!key || key.length < 4) return;
      if (haystack.indexOf(key) !== -1 && key.length > P.searchKey(best).length) best = a;
    });
    out.area = best;

    return out;
  }

  /** Free the worker (and its ~9 MB of memory) once scanning is done. */
  function release() {
    if (!workerPromise) return Promise.resolve();
    var p = workerPromise;
    workerPromise = null;
    return p.then(function (w) { return w.terminate(); }).catch(function () {});
  }

  DD.ocr = {
    recognize: recognize,
    extract: extract,
    findMobiles: findMobiles,
    asciiDigits: asciiDigits,
    release: release,
    isLoaded: function () { return !!workerPromise; }
  };
})(window.DD = window.DD || {});
