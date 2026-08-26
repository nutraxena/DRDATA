/* Dr-Diary — router, event wiring, import flow. */
(function (DD) {
  'use strict';

  var P = DD.parse;
  var S = DD.store;
  var V = DD.views;
  var IO = DD.io;

  var app = document.getElementById('app');
  var qInput = document.getElementById('q');
  var qClear = document.getElementById('q-clear');
  var modal = document.getElementById('modal');
  var modalBody = document.getElementById('modal-body');
  var modalTitle = document.getElementById('modal-title');
  var toastEl = document.getElementById('toast');

  var PH = DD.photos;
  var OCR = DD.ocr;

  var searchQuery = '';
  var toastTimer = null;
  var pending = null;        // staged import awaiting confirmation
  var pendingCard = null;    // { blob, url } captured, not yet saved
  var cardTargetId = null;   // doctor the next capture belongs to, null = new doctor
  var pendingDoctor = null;  // { payload, card } held while the duplicate prompt is up
  var ocrRun = 0;            // bumped to abandon an in-flight scan the user skipped
  var camStream = null;      // live webcam stream, laptop only

  /* ---------- theme ---------- */

  function applyTheme(mode) {
    var resolved = mode;
    if (mode === 'auto') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b1220' : '#0f766e');
  }

  function initTheme() {
    applyTheme(S.settings().theme || 'auto');
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if ((S.settings().theme || 'auto') === 'auto') applyTheme('auto');
    });
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var cur = S.settings().theme || 'auto';
    var next = order[(order.indexOf(cur) + 1) % order.length];
    S.settings().theme = next;
    S.save();
    applyTheme(next);
    toast('Theme: ' + next);
  }

  /* ---------- toast ---------- */

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 2600);
  }

  /* ---------- modal ---------- */

  function openModal(heading, html) {
    modalTitle.textContent = heading;
    modalBody.innerHTML = html;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
    var first = modalBody.querySelector('input, select, textarea, button');
    if (first) first.focus();
  }

  function closeModal() {
    modal.hidden = true;
    modalBody.innerHTML = '';
    document.body.style.overflow = '';
    // Never leave the webcam light on after the dialog goes away.
    stopWebcam();
    // A capture the user backed out of should not linger.
    if (pendingCard) { URL.revokeObjectURL(pendingCard.url); pendingCard = null; }
    if (pendingDoctor) {
      if (pendingDoctor.card) URL.revokeObjectURL(pendingDoctor.card.url);
      pendingDoctor = null;
    }
  }

  /* ---------- lightbox ---------- */

  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightbox-img');

  function openLightbox(src) {
    lightboxImg.src = src;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.hidden = true;
    lightboxImg.removeAttribute('src');
    document.body.style.overflow = modal.hidden ? '' : 'hidden';
  }

  /* ---------- router ---------- */

  function parseHash() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('?');
    var segs = parts[0].split('/').filter(function (s) { return s !== ''; });
    var params = {};
    (parts[1] || '').split('&').filter(Boolean).forEach(function (pair) {
      var kv = pair.split('=');
      params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return { segs: segs, params: params };
  }

  function render() {
    var r = parseHash();
    var view = r.segs[0] || 'home';
    var html;

    // Typing in the search box always means "show me matching doctors".
    if (searchQuery && view !== 'doctors' && view !== 'data') view = 'doctors';

    switch (view) {
      case 'home': html = V.home(); break;
      case 'days': html = V.days(); break;
      case 'day': html = V.day(decodeURIComponent(r.segs[1] || '')); break;
      case 'areas': html = V.areas(); break;
      case 'area': html = V.area(decodeURIComponent(r.segs[1] || '')); break;
      case 'doctors':
        if (r.params.filter) V.filterState.only = r.params.filter;
        // The bottom-nav tabs are the same list pre-filtered by type.
        if (r.params.type !== undefined) {
          V.filterState.type = S.TYPES[r.params.type] ? r.params.type : '';
          if (V.filterState.type && V.filterState.type !== 'doctor') V.filterState.speciality = '';
        }
        html = V.doctors(searchQuery);
        break;
      case 'dr': html = V.doctor(decodeURIComponent(r.segs[1] || '')); break;
      case 'data': html = V.data(); break;
      default: html = V.notFound('Page');
    }

    // Release the previous screen's image URLs before dropping its DOM.
    PH.releaseURLs();
    app.innerHTML = html;
    window.scrollTo(0, 0);
    highlightNav(view);
    if (view === 'data') afterDataRender();
    if (view === 'dr') loadCardInto(r.segs[1] ? decodeURIComponent(r.segs[1]) : '');
  }

  /** The doctor detail view renders a placeholder; fill it once IndexedDB answers. */
  function loadCardInto(id) {
    var slot = document.getElementById('card-slot');
    if (!slot) return;
    var d = S.get(id);
    if (!d || !d.card) return;

    PH.get(id).then(function (blob) {
      if (!document.body.contains(slot)) return;
      if (!blob) {
        // Flag said there was a card but the blob is gone (cleared storage).
        S.setCard(id, false);
        slot.innerHTML = V.cardEmpty(id);
        return;
      }
      slot.innerHTML = V.cardShown(id, PH.objectURL(blob), PH.formatSize(blob.size));
    }).catch(function (e) {
      slot.innerHTML = '<div class="warnbox">Could not load the card: ' + V.h(e.message) + '</div>';
    });
  }

  function highlightNav(view) {
    var map = { home: 'home', days: 'days', day: 'days', areas: 'areas', area: 'areas', data: 'data' };
    var target = map[view] || '';
    // Doctors / Medical / Distributor are one screen; the active type picks the tab.
    if (view === 'doctors' || view === 'dr') {
      target = V.filterState.type || 'doctor';
    }
    document.querySelectorAll('.bottomnav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === target);
    });
  }

  /* ---------- search ---------- */

  var searchTimer = null;
  qInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      searchQuery = qInput.value.trim();
      qClear.hidden = !searchQuery;
      if (searchQuery && (parseHash().segs[0] || 'home') !== 'doctors') {
        location.hash = '#/doctors';
        return; // hashchange triggers render
      }
      render();
    }, 180);
  });

  qClear.addEventListener('click', function () {
    qInput.value = '';
    searchQuery = '';
    qClear.hidden = true;
    render();
    qInput.focus();
  });

  /* ---------- global click handling ---------- */

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close-lightbox]') || e.target === lightbox) { closeLightbox(); return; }
    if (e.target.closest('[data-close]')) { closeModal(); return; }

    var actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      var handled = handleAction(actionEl.getAttribute('data-action'), actionEl, e);
      if (handled) { e.preventDefault(); e.stopPropagation(); return; }
    }

    // Real links inside a card must not also trigger the card's navigation.
    if (e.target.closest('[data-stop]')) { e.stopPropagation(); return; }

    var cardLink = e.target.closest('[data-href]');
    if (cardLink) { location.hash = cardLink.getAttribute('data-href'); }
  });

  // Cards are role="link"; keyboard users expect Enter/Space to work.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !lightbox.hidden) { closeLightbox(); return; }
    if (e.key === 'Escape' && !modal.hidden) { closeModal(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var card = e.target.closest && e.target.closest('[data-href]');
    if (card && e.target === card) {
      e.preventDefault();
      location.hash = card.getAttribute('data-href');
    }
  });

  document.getElementById('btn-theme').addEventListener('click', cycleTheme);

  // The headline way to add a doctor: point the camera at their card.
  document.getElementById('btn-scan').addEventListener('click', function () { startScan(null); });

  // The + button offers all three ways in, so the choice is one tap from anywhere.
  document.getElementById('btn-add').addEventListener('click', function () {
    openModal('Add a doctor',
      '<p class="hint" style="margin-top:0">How would you like to add them?</p>' +
      S.TYPE_KEYS.map(function (k) {
        var m = S.TYPES[k];
        return '<button class="btn wide" data-action="add-manual" data-type="' + k +
          '" style="margin-bottom:8px">' + m.icon + ' Add a ' + m.label + '</button>';
      }).join('') +
      '<button class="btn wide" data-action="card-camera" style="margin-bottom:8px">📷 Visiting card — camera</button>' +
      '<button class="btn wide" data-action="card-gallery" style="margin-bottom:8px">🖼 Visiting card — gallery</button>' +
      '<a class="btn wide" href="#/data" data-close="1">📄 Excel / CSV import</a>');
  });

  /* ---------- actions ---------- */

  function handleAction(action, el, e) {
    var id = el.getAttribute('data-id');

    switch (action) {
      case 'visit':
        openModal('Visit done — ' + P.titleCase((S.get(id) || {}).name || ''), V.visitForm(S.get(id)));
        return true;

      case 'del-visit':
        if (confirm('Delete this visit record?')) {
          S.removeVisit(id, parseInt(el.getAttribute('data-index'), 10));
          render();
          toast('Visit deleted');
        }
        return true;

      case 'edit-doctor':
        openModal('Edit doctor', V.doctorForm(S.get(id)));
        return true;

      case 'delete-doctor': {
        var d = S.get(id);
        if (d && confirm('"' + P.titleCase(d.name) + '" will be removed. This cannot be undone.')) {
          S.remove(id);
          closeModal();
          location.hash = '#/doctors';
          render();
          toast('Doctor removed');
        }
        return true;
      }

      case 'add-slot': {
        var scope = el.closest('.formgroup') || el.closest('form') || document;
        var host = scope.querySelector('[data-slots]');
        if (host) host.insertAdjacentHTML('beforeend', V.slotRow(null));
        return true;
      }

      case 'del-slot': {
        var row = el.closest('.slotrow');
        var container = row && row.parentElement;
        if (row && container.children.length > 1) row.remove();
        else if (row) toast('At least one row is needed');
        return true;
      }

      case 'set-type': {
        // Go through the URL, not straight to render: the hash carries ?type=
        // for the bottom-nav tabs, and re-rendering without updating it would
        // let the old value come straight back on the next render.
        var want = el.getAttribute('data-type') || '';
        var next = '#/doctors' + (want ? '?type=' + want : '?type=');
        if (location.hash === next) { V.filterState.type = want; render(); }
        else location.hash = next;
        return true;
      }

      case 'set-view':
        S.settings().docView = el.getAttribute('data-mode');
        S.save();
        render();
        return true;

      case 'clear-filters':
        V.filterState.type = V.filterState.area = V.filterState.speciality = V.filterState.day = V.filterState.only = '';
        qInput.value = '';
        searchQuery = '';
        qClear.hidden = true;
        render();
        return true;

      case 'add-manual': {
        var wantType = el.getAttribute('data-type') || 'doctor';
        var blank = V.blankRecord(wantType);
        openModal('New ' + S.TYPES[wantType].label, V.doctorForm(blank));
        return true;
      }

      // data-id present = attach to that doctor; absent = create a new one.
      case 'card-camera':
        startScan(id);
        return true;

      case 'card-gallery':
        cardTargetId = id || null;
        document.getElementById('card-gallery-input').click();
        return true;

      case 'cam-shoot': {
        var vid = document.getElementById('cam-video');
        if (!vid || !vid.videoWidth) { toast('Camera is not ready yet'); return true; }
        var cv = document.createElement('canvas');
        cv.width = vid.videoWidth;
        cv.height = vid.videoHeight;
        cv.getContext('2d').drawImage(vid, 0, 0);
        var camTarget = cardTargetId;
        cardTargetId = null;
        stopWebcam();
        cv.toBlob(function (blob) {
          if (!blob) { closeModal(); alert('Could not capture the photo.'); return; }
          handleCardBlob(blob, camTarget);
        }, 'image/jpeg', 0.92);
        return true;
      }

      case 'cam-file': {
        var fileTarget = cardTargetId;
        stopWebcam();
        closeModal();
        cardTargetId = fileTarget;
        document.getElementById('card-gallery-input').click();
        return true;
      }

      case 'card-delete':
        if (confirm('Delete this visiting card photo? The doctor\u2019s details will stay.')) {
          PH.del(id).then(function () {
            S.setCard(id, false);
            var slot = document.getElementById('card-slot');
            if (slot) slot.innerHTML = V.cardEmpty(id);
            toast('Card photo removed');
          }).catch(function (err) { alert('Could not delete: ' + err.message); });
        }
        return true;

      case 'zoom-card':
        openLightbox(el.getAttribute('src'));
        return true;

      case 'dup-use-existing': {
        var pd = pendingDoctor;
        pendingDoctor = null;
        if (!pd) { closeModal(); return true; }
        if (pd.card) {
          attachCard(id, pd.card.blob).then(function () {
            URL.revokeObjectURL(pd.card.url);
            location.hash = '#/dr/' + encodeURIComponent(id);
          }).catch(function (err) {
            URL.revokeObjectURL(pd.card.url);
            alert('Could not save the card: ' + err.message);
          });
        } else {
          closeModal();
          location.hash = '#/dr/' + encodeURIComponent(id);
        }
        return true;
      }

      case 'dup-create': {
        var pc = pendingDoctor;
        pendingDoctor = null;
        if (!pc) { closeModal(); return true; }
        commitDoctor(pc.payload, null, pc.card);
        return true;
      }

      case 'dup-back': {
        var pb = pendingDoctor;
        pendingDoctor = null;
        if (!pb) { closeModal(); return true; }
        pendingCard = pb.card; // hand ownership back to the form
        openModal('New doctor', V.doctorForm(pb.payload, pb.card ? pb.card.url : null));
        return true;
      }

      case 'export-json':
        IO.exportJSON();
        toast('JSON backup downloaded');
        return true;

      case 'export-full':
        toast('Building the full backup…');
        IO.exportFullBackup().then(function (info) {
          toast(info.count + ' cards — backup ready');
        }).catch(function (err) { alert('Backup failed: ' + err.message); });
        return true;

      case 'export-xlsx':
        IO.exportXLSX();
        toast('Excel downloaded');
        return true;

      case 'ocr-skip':
        // Abandon the scan result so a late finish cannot overwrite typing.
        ocrRun++;
        showCardForm(null);
        return true;

      case 'do-import':
        confirmImport(el.getAttribute('data-mode'));
        return true;

      case 'cancel-import':
        pending = null;
        render();
        return true;

      default:
        return false;
    }
  }

  /* ---------- forms ---------- */

  /**
   * Write the doctor, then its visiting card if one was captured. The record is
   * saved either way — if only the image fails, say so instead of reporting a
   * clean success.
   */
  /**
   * Read the day/time rows out of a form. Each row can have several days ticked
   * (Tue + Thu, or Mon + Wed + Sat); every one becomes its own stored slot, so
   * the day views keep working off plain single-day entries.
   */
  /**
   * Keep a slot row's day chips coherent. "Any Day" means the day is not fixed,
   * so it cannot sit alongside specific days — ticking either side clears the
   * other. The `.on` class drives the styling (no reliance on :has()).
   */
  function syncDayChips(changed) {
    var row = changed.closest('.slotrow');
    var boxes = row.querySelectorAll('[name="day"]');

    if (changed.value === 'ANY' && changed.checked) {
      Array.prototype.forEach.call(boxes, function (b) {
        if (b.value !== 'ANY') b.checked = false;
      });
    } else if (changed.value !== 'ANY' && changed.checked) {
      Array.prototype.forEach.call(boxes, function (b) {
        if (b.value === 'ANY') b.checked = false;
      });
    }

    Array.prototype.forEach.call(boxes, function (b) {
      b.closest('.daychip-pick').classList.toggle('on', b.checked);
    });
  }

  /**
   * Switching Doctor / Medical / Distributor changes the field labels, so the
   * form is rebuilt — carrying across whatever has already been typed, and the
   * day rows, so nothing is lost mid-entry.
   */
  function rerenderDoctorForm(form, newType) {
    var val = function (n) {
      var el = form.querySelector('[name="' + n + '"]');
      return el ? el.value : '';
    };
    var draft = {
      id: form.getAttribute('data-id') || '',
      type: newType,
      name: val('name'), hospital: val('hospital'), mobile: val('mobile'),
      area: val('area'), speciality: val('speciality'), category: val('category'),
      city: val('city'), state: val('state'), notes: val('notes'),
      slots: collectSlots(form)
    };
    var cardURL = form.getAttribute('data-card') && pendingCard ? pendingCard.url : null;
    var banner = modalBody.querySelector('.okbox, .warnbox');
    modalBody.innerHTML = (banner ? banner.outerHTML : '') + V.doctorForm(draft, cardURL);
    var nameInput = modalBody.querySelector('[name="name"]');
    if (nameInput) nameInput.focus();
  }

  function collectSlots(form) {
    var slots = [];
    var seen = {};
    form.querySelectorAll('.slotrow').forEach(function (row) {
      var time = row.querySelector('[name="time"]').value || null;
      var place = P.clean(row.querySelector('[name="place"]').value);
      var checked = row.querySelectorAll('[name="day"]:checked');
      if (!checked.length) return; // a row with no day ticked adds nothing

      Array.prototype.forEach.call(checked, function (box) {
        var dayKey = box.value;
        var key = dayKey + '|' + (time || '') + '|' + place;
        if (seen[key]) return;
        seen[key] = 1;
        slots.push({ day: dayKey, time: time, place: place });
      });
    });
    return slots;
  }

  function commitDoctor(payload, existing, card) {
    payload.card = !!card || (existing ? existing.card : false);
    var saved = S.upsert(payload);

    var goTo = function () {
      closeModal();
      if (!existing) location.hash = '#/dr/' + encodeURIComponent(saved.id);
      else render();
    };

    if (!card) { goTo(); toast('Saved'); return saved; }

    PH.put(saved.id, card.blob).then(function () {
      URL.revokeObjectURL(card.url);
      goTo();
      toast('Doctor and card saved');
    }).catch(function (err) {
      URL.revokeObjectURL(card.url);
      S.setCard(saved.id, false);
      goTo();
      alert('Doctor saved, but the card photo could not be saved: ' + err.message);
    });
    return saved;
  }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    var kind = form.getAttribute('data-form');
    if (!kind) return;
    e.preventDefault();
    var id = form.getAttribute('data-id');

    if (kind === 'doctor') {
      var fd = new FormData(form);
      var name = P.clean(fd.get('name'));
      if (!name) { toast('Doctor name is required'); return; }
      var existing = id ? S.get(id) : null;
      var payload = {
        id: id || S.nextId(),
        type: fd.get('type') || (existing ? existing.type : 'doctor'),
        name: name,
        hospital: P.clean(fd.get('hospital')),
        mobile: P.parseMobile(fd.get('mobile')) || P.clean(fd.get('mobile')),
        area: P.clean(fd.get('area')),
        city: P.clean(fd.get('city')),
        state: P.clean(fd.get('state')),
        speciality: P.clean(fd.get('speciality')),
        category: P.clean(fd.get('category')),
        slots: collectSlots(form),
        notes: fd.get('notes') !== null ? String(fd.get('notes')) : (existing ? existing.notes : ''),
        visits: existing ? existing.visits : []
      };
      // A brand-new doctor that matches one already on file is almost always a
      // mistake — offer to use the existing record instead of quietly forking it.
      if (!existing) {
        var matches = S.findSimilar(payload);
        if (matches.length) {
          pendingDoctor = { payload: payload, card: pendingCard };
          pendingCard = null; // ownership moves to pendingDoctor
          openModal('This doctor already exists', V.duplicateChoice(matches, !!pendingDoctor.card));
          return;
        }
      }

      commitDoctor(payload, existing, pendingCard);
      pendingCard = null;
      return;
    }

    if (kind === 'visit') {
      S.addVisit(id, new FormData(form).get('note'));
      closeModal();
      render();
      toast('Visit recorded ✅');
    }
  });

  // Notes auto-save while typing, debounced so we are not writing every keystroke.
  var noteTimer = null;
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.getAttribute && el.getAttribute('data-action') === 'notes') {
      clearTimeout(noteTimer);
      var id = el.getAttribute('data-id');
      var val = el.value;
      noteTimer = setTimeout(function () {
        var d = S.get(id);
        if (!d) return;
        d.notes = val;
        S.upsert(d);
      }, 600);
    }
  });

  document.addEventListener('change', function (e) {
    if (e.target.name === 'type' && e.target.closest('[data-form="doctor"]')) {
      rerenderDoctorForm(e.target.closest('[data-form="doctor"]'), e.target.value);
      return;
    }

    if (e.target.name === 'day' && e.target.closest('.slotrow')) {
      syncDayChips(e.target);
      return;
    }

    var f = e.target.getAttribute && e.target.getAttribute('data-filter');
    if (f) {
      V.filterState[f] = e.target.value;
      render();
      return;
    }
    if (e.target.id === 'file-input') handleFile(e.target.files[0]);
    if (e.target.id === 'card-camera-input' || e.target.id === 'card-gallery-input') {
      handleCardFile(e.target.files[0], e.target);
    }
    if (e.target.getAttribute && e.target.getAttribute('data-map')) restageMapping();
  });

  /* ---------- visiting card capture ---------- */

  /**
   * A phone has a real camera behind the file input: `capture="environment"`
   * makes it open the camera straight away. A laptop ignores `capture` and
   * would pop a file browser instead, so there we drive the webcam ourselves.
   */
  function isHandheld() {
    // `maxTouchPoints > 0` is not usable here — plenty of Windows laptops have
    // touchscreens and would wrongly get the phone path. "Coarse pointer AND no
    // hover" is true only where touch is the *only* way to point, i.e. a phone
    // or tablet.
    return window.matchMedia('(pointer: coarse) and (hover: none)').matches;
  }

  function startScan(targetId) {
    cardTargetId = targetId || null;
    if (isHandheld() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      document.getElementById('card-camera-input').click();
      return;
    }
    openWebcam();
  }

  function openWebcam() {
    openModal('Take a photo of the card', V.cameraView());
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }
    }).then(function (stream) {
      var v = document.getElementById('cam-video');
      if (!v) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      camStream = stream;
      v.srcObject = stream;
      var hint = document.getElementById('cam-hint');
      if (hint) hint.textContent = 'Line the card up in the frame. Good light gives a better read.';
    }).catch(function () {
      // No webcam, or permission refused. Fall back to picking a file, but say
      // so — otherwise tapping "camera" and getting a file browser is baffling.
      closeModal();
      toast('Camera would not open — choose a file');
      document.getElementById('card-gallery-input').click();
    });
  }

  function stopWebcam() {
    if (!camStream) return;
    camStream.getTracks().forEach(function (t) { t.stop(); });
    camStream = null;
  }

  function handleCardFile(file, input) {
    if (!file) return;
    var targetId = cardTargetId;
    cardTargetId = null;
    input.value = ''; // so picking the same file twice still fires change

    if (!/^image\//.test(file.type)) { alert('That is not an image file.'); return; }
    handleCardBlob(file, targetId);
  }

  /** Shared by the file input and the webcam shutter. */
  function handleCardBlob(blob, targetId) {
    openModal('Processing the card', '<div class="busy">📷 Compressing the photo…</div>');

    PH.compress(blob).then(function (small) {
      if (targetId) return attachCard(targetId, small);
      // Store the compressed copy, but read from the original: compression
      // softens small print, which is exactly what the reader needs.
      return newDoctorFromCard(small, blob);
    }).catch(function (err) {
      closeModal();
      alert('Could not save the photo: ' + err.message);
    });
  }

  /** Existing doctor — store the blob, flag it, and refresh the card section. */
  function attachCard(id, blob) {
    return PH.put(id, blob).then(function () {
      S.setCard(id, true);
      closeModal();
      var slot = document.getElementById('card-slot');
      if (slot) slot.innerHTML = V.cardShown(id, PH.objectURL(blob), PH.formatSize(blob.size));
      else render();
      toast('Visiting card saved (' + PH.formatSize(blob.size) + ')');
    });
  }

  /**
   * New doctor — read the card, prefill the form, and hold the blob aside. The
   * image is only committed once the form is saved.
   */
  function newDoctorFromCard(blob, original) {
    pendingCard = { blob: blob, url: URL.createObjectURL(blob) };
    var run = ++ocrRun;

    openModal('Reading the card', V.ocrProgress(pendingCard.url));

    OCR.recognize(original || blob, function (m) {
      if (run !== ocrRun) return;
      var fill = document.getElementById('ocr-fill');
      var status = document.getElementById('ocr-status');
      if (!fill || !status) return;
      // Tesseract reports several phases; only 'recognizing text' has a
      // meaningful fraction, the rest are one-off downloads.
      var pct = Math.round((m.progress || 0) * 100);
      fill.style.width = pct + '%';
      status.textContent = m.status === 'recognizing text'
        ? 'Reading the card… ' + pct + '%'
        : (m.status || 'loading') + '…';
    }).then(function (text) {
      if (run !== ocrRun) return; // user skipped; their typing must not be clobbered
      var areas = S.facet('area').map(function (a) { return a.value; });
      var found = OCR.extract(text, areas);
      showCardForm(found);
    }).catch(function (err) {
      if (run !== ocrRun) return;
      console.warn('OCR fail:', err);
      showCardForm(null, err.message);
    });

    return null;
  }

  /** Form with whatever the scan managed to read, card photo above it. */
  function showCardForm(found, errMessage) {
    if (!pendingCard) return;
    var prefill = found ? {
      id: '', name: found.name, hospital: found.hospital, mobile: found.mobile,
      area: found.area, city: 'AHMEDABAD', state: 'GUJARAT',
      speciality: found.speciality || 'Orthopaedic', category: '', notes: ''
    } : null;

    var banner = errMessage
      ? '<div class="warnbox">Could not read the card (' + V.h(errMessage) + '). Please type it in below.</div>'
      : (found ? V.ocrSummary(found) : '');

    openModal('Add a doctor from the card', banner + V.doctorForm(prefill, pendingCard.url));
  }

  /* ---------- import flow ---------- */

  function stageEl() { return document.getElementById('import-stage'); }

  function handleFile(file) {
    if (!file) return;
    var host = stageEl();
    if (host) host.innerHTML = '<p class="hint">Reading ' + V.h(file.name) + '…</p>';

    IO.readFile(file).then(function (res) {
      if (res.kind === 'json') {
        pending = { kind: 'json', doctors: res.doctors, photos: res.photos, fileName: file.name };
        renderStage();
        return;
      }
      var found = IO.findHeaderRow(res.rows);
      if (!found) {
        stageEl().innerHTML = '<div class="warnbox">No doctor-name column found. ' +
          'The sheet needs a header row containing <b>DR NAME</b> or <b>DOCTOR NAME</b>.</div>';
        return;
      }
      pending = {
        kind: 'sheet',
        rows: res.rows,
        headerIndex: found.index,
        map: found.map,
        fileName: file.name
      };
      renderStage();
    }).catch(function (err) {
      stageEl().innerHTML = '<div class="warnbox">Import fail: ' + V.h(err.message) + '</div>';
    });
  }

  function restageMapping() {
    if (!pending || pending.kind !== 'sheet') return;
    var map = {};
    document.querySelectorAll('[data-map]').forEach(function (sel) {
      if (sel.value !== '') map[sel.getAttribute('data-map')] = parseInt(sel.value, 10);
    });
    pending.map = map;
    renderStage(true);
  }

  function renderStage(keepMapping) {
    var host = stageEl();
    if (!host || !pending) return;

    if (pending.kind === 'json') {
      var nPhotos = pending.photos ? Object.keys(pending.photos).length : 0;
      host.innerHTML = '<div class="warnbox">Backup file: <b>' + V.h(pending.fileName) + '</b> — ' +
          pending.doctors.length + ' contacts' +
          (nPhotos ? ' and ' + plural(nPhotos, 'visiting card') : '') + ' found.</div>' + importButtons();
      return;
    }

    var headers = pending.rows[pending.headerIndex].map(function (c) { return P.clean(c); });
    var docs = IO.buildDoctors(pending.rows, pending.headerIndex, pending.map);
    pending.preview = docs;

    var mapping = IO.FIELDS.map(function (f) {
      var opts = '<option value="">— skip —</option>' + headers.map(function (hd, i) {
        return '<option value="' + i + '"' + (pending.map[f.key] === i ? ' selected' : '') + '>' +
          V.h(hd || ('Column ' + (i + 1))) + '</option>';
      }).join('');
      return '<div class="maprow"><span>' + V.h(f.label) + (f.required ? ' *' : '') + '</span>' +
        '<select data-map="' + f.key + '">' + opts + '</select></div>';
    }).join('');

    var withDay = docs.filter(function (d) { return d.slots.length; }).length;
    var withMobile = docs.filter(function (d) { return d.mobile; }).length;

    var preview = '<div class="preview"><table><thead><tr>' +
      '<th>Name</th><th>Hospital</th><th>Mobile</th><th>Area</th><th>Day</th><th>Time</th></tr></thead><tbody>' +
      docs.slice(0, 8).map(function (d) {
        return '<tr><td>' + V.h(P.titleCase(d.name)) + '</td><td>' + V.h(d.hospital) + '</td>' +
          '<td>' + V.h(d.mobile) + '</td><td>' + V.h(P.titleCase(d.area)) + '</td>' +
          '<td>' + V.h(d.slots.map(function (s) { return P.DAY_SHORT[s.day]; }).join(', ')) + '</td>' +
          '<td>' + V.h(d.slots.length ? P.formatTime(d.slots[0].time) : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';

    host.innerHTML =
      '<div class="warnbox"><b>' + V.h(pending.fileName) + '</b> — ' + docs.length + ' doctors, ' +
        withMobile + ' with a mobile, ' + withDay + ' already have a day set.</div>' +
      '<details' + (keepMapping ? ' open' : '') + ' class="anyblock" style="margin:0 0 12px">' +
        '<summary>Column mapping ' + (keepMapping ? '' : '(auto-detected — tap to change)') + '</summary>' +
        mapping +
      '</details>' +
      preview + importButtons();
  }

  function importButtons() {
    var have = S.all().length;
    return '<div class="btnrow" style="margin-top:12px">' +
      '<button class="btn primary" data-action="do-import" data-mode="merge">' +
        (have ? 'Merge (safe)' : 'Import') + '</button>' +
      (have ? '<button class="btn danger" data-action="do-import" data-mode="replace">Replace all</button>' : '') +
      '<button class="btn" data-action="cancel-import">Cancel</button>' +
    '</div>' +
    (have ? '<p class="hint">Merge: matches on name and mobile and updates the details, keeping the ' +
      'days, times, notes and visit history you have entered. Replace: wipes everything and starts fresh.</p>' : '');
  }

  function confirmImport(mode) {
    if (!pending) return;
    var docs = pending.kind === 'json' ? pending.doctors : (pending.preview || []);
    if (!docs.length) { toast('Nothing found to import'); return; }
    if (mode === 'replace' && !confirm('Mojuda ' + S.all().length + ' contacts will be deleted, along with their notes and visits. Are you sure?')) return;

    var photos = pending.photos;
    var res = S.importDoctors(docs, mode);
    pending = null;
    document.getElementById('file-input').value = '';

    // Card images come back keyed by the same doctor ids the backup was written
    // with, so restore them only when those ids actually survived the import.
    if (photos) {
      IO.restorePhotos(photos, res.idMap).then(function (n) {
        render();
        toast(res.added + ' added, ' + res.updated + ' updated, ' + plural(n, 'card') + ' restored');
      }).catch(function () {
        render();
        toast(res.added + ' added, ' + res.updated + ' updated — cards could not be restored');
      });
      return;
    }

    render();
    toast(res.added + ' added, ' + res.updated + ' updated — total ' + res.total);
  }

  /* ---------- data screen extras ---------- */

  function afterDataRender() {
    var usageEl = document.getElementById('card-usage');
    if (usageEl) {
      PH.usage().then(function (u) {
        usageEl.textContent = u.count
          ? plural(u.count, 'card') + ' · ' + PH.formatSize(u.bytes)
          : 'No cards';
      });
    }

    var el = document.getElementById('sw-status');
    if (!el) return;
    if (!('serviceWorker' in navigator)) { el.textContent = 'Not supported by this browser'; return; }
    navigator.serviceWorker.getRegistration().then(function (reg) {
      el.textContent = reg ? 'Ready — works offline' : 'Not registered (open over http)';
    }).catch(function () { el.textContent = 'Unknown'; });
    if (pending) renderStage();
  }

  /* ---------- boot ---------- */

  window.addEventListener('hashchange', render);

  initTheme();
  S.load();
  if (!location.hash) location.hash = '#/';
  render();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('Service worker did not register:', e.message);
      });
    });
  }
})(window.DD = window.DD || {});
