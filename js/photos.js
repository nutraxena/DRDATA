/* Dr-Diary — visiting card photos.
   Images live in IndexedDB, not localStorage: a single card is bigger than the
   whole doctor list, and localStorage's ~5 MB quota would fill after a handful.
   The doctor record only carries a `card: true` flag; the blob is keyed by id. */
(function (DD) {
  'use strict';

  var DB_NAME = 'dr-diary-photos';
  var STORE = 'cards';
  var dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB is not supported')); return; }
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB could not be opened')); };
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, mode);
        var req = fn(t.objectStore(STORE));
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error || new Error('Transaction abort')); };
        if (req) req.onsuccess = function () { resolve(req.result); };
        else t.oncomplete = function () { resolve(); };
      });
    });
  }

  function put(id, blob) { return tx('readwrite', function (s) { return s.put(blob, id); }); }
  function get(id) { return tx('readonly', function (s) { return s.get(id); }); }
  function del(id) { return tx('readwrite', function (s) { return s.delete(id); }); }
  function keys() { return tx('readonly', function (s) { return s.getAllKeys(); }); }
  function clear() { return tx('readwrite', function (s) { return s.clear(); }); }

  /**
   * Shrink a camera photo down to something a phone can hold hundreds of.
   * A 12 MP capture is ~4 MB; this lands around 150-300 KB while keeping a
   * printed phone number readable.
   */
  var MAX_EDGE = 1400;
  var QUALITY = 0.72;

  function compress(file) {
    return loadBitmap(file).then(function (img) {
      var w = img.width, hgt = img.height;
      var scale = Math.min(1, MAX_EDGE / Math.max(w, hgt));
      var cw = Math.round(w * scale), ch = Math.round(hgt * scale);

      var canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      var ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);
      if (img.close) img.close();

      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (blob) resolve(blob);
          else reject(new Error('Could not process the photo'));
        }, 'image/jpeg', QUALITY);
      });
    });
  }

  /** createImageBitmap applies EXIF rotation; the <img> fallback does too in
      modern browsers, so portrait phone shots do not come out sideways. */
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' })
        .catch(function () { return loadViaImg(file); });
    }
    return loadViaImg(file);
  }

  function loadViaImg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not read that image file')); };
      img.src = url;
    });
  }

  /**
   * Tesseract reads a clean, large, high-contrast image far better than a phone
   * snap. The stored copy stays small for space; this one is built only to be
   * read: upscaled, greyscale, and stretched so ink is black and paper is white.
   */
  // 1800px is the sweet spot: small print still has enough pixels, but the
  // layout pass stays fast. Going bigger made a grainy photo take over 30s.
  var OCR_EDGE = 1800;

  function prepareForOcr(file) {
    return loadBitmap(file).then(function (img) {
      var scale = OCR_EDGE / Math.max(img.width, img.height);
      if (scale < 1) scale = 1;              // never shrink, small text needs pixels
      if (scale > 2) scale = 2;              // upscaling past this only adds noise
      var w = Math.round(img.width * scale), hh = Math.round(img.height * scale);

      var canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = hh;
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingQuality = 'high';
      // A whisper of blur first: camera grain would otherwise be amplified by
      // the contrast stretch below into thousands of speckles, and Tesseract
      // spends its time trying to read those as characters.
      ctx.filter = 'blur(0.6px)';
      ctx.drawImage(img, 0, 0, w, hh);
      ctx.filter = 'none';
      if (img.close) img.close();

      var d = ctx.getImageData(0, 0, w, hh);
      var px = d.data;
      var i;

      // Greyscale, and collect a histogram in the same pass.
      var hist = new Uint32Array(256);
      for (i = 0; i < px.length; i += 4) {
        var g = (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114) | 0;
        px[i] = px[i + 1] = px[i + 2] = g;
        hist[g]++;
      }

      // Auto-levels: ignore the extreme 1% at each end so one dark shadow or
      // one bright glare spot cannot flatten the whole card.
      var total = w * hh, cut = total * 0.01, acc = 0, lo = 0, hi = 255;
      for (i = 0; i < 256; i++) { acc += hist[i]; if (acc > cut) { lo = i; break; } }
      acc = 0;
      for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc > cut) { hi = i; break; } }
      if (hi - lo < 32) { lo = 0; hi = 255; }   // already flat, leave it alone

      var span = hi - lo;
      var lut = new Uint8Array(256);
      for (i = 0; i < 256; i++) {
        var v = ((i - lo) / span) * 255;
        lut[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      for (i = 0; i < px.length; i += 4) {
        px[i] = px[i + 1] = px[i + 2] = lut[px[i]];
      }
      ctx.putImageData(d, 0, 0);

      return new Promise(function (resolve, reject) {
        // PNG: JPEG artefacts around letter edges are exactly what confuses OCR.
        canvas.toBlob(function (b) {
          if (b) resolve(b); else reject(new Error('Could not prepare the image'));
        }, 'image/png');
      });
    });
  }

  /* Object URLs must be released or the tab leaks memory as you browse. */
  var live = [];
  function objectURL(blob) {
    var u = URL.createObjectURL(blob);
    live.push(u);
    return u;
  }
  function releaseURLs() {
    live.forEach(function (u) { URL.revokeObjectURL(u); });
    live = [];
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function dataURLToBlob(dataURL) {
    var parts = String(dataURL).split(',');
    var mime = (parts[0].match(/:(.*?);/) || [])[1] || 'image/jpeg';
    var bin = atob(parts[1]);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /** Rough total size, so the Data screen can show how much space cards take. */
  function usage() {
    return keys().then(function (ids) {
      return Promise.all(ids.map(function (id) {
        return get(id).then(function (b) { return b ? b.size : 0; });
      })).then(function (sizes) {
        return { count: ids.length, bytes: sizes.reduce(function (a, b) { return a + b; }, 0) };
      });
    }).catch(function () { return { count: 0, bytes: 0 }; });
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  DD.photos = {
    put: put,
    get: get,
    del: del,
    keys: keys,
    clear: clear,
    compress: compress,
    prepareForOcr: prepareForOcr,
    objectURL: objectURL,
    releaseURLs: releaseURLs,
    blobToDataURL: blobToDataURL,
    dataURLToBlob: dataURLToBlob,
    usage: usage,
    formatSize: formatSize
  };
})(window.DD = window.DD || {});
