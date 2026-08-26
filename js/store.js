/* Dr-Diary — localStorage-backed data store. Everything lives on this device. */
(function (DD) {
  'use strict';

  var P = DD.parse;
  var KEY = 'dr-diary/v1';
  var SCHEMA = 1;

  var state = null;
  var listeners = [];

  function emptyState() {
    return { version: SCHEMA, doctors: [], settings: { lastImport: null, theme: 'auto' } };
  }

  function load() {
    if (state) return state;
    try {
      var raw = localStorage.getItem(KEY);
      state = raw ? migrate(JSON.parse(raw)) : emptyState();
    } catch (e) {
      console.error('Could not read saved data, starting empty:', e);
      state = emptyState();
    }
    return state;
  }

  function migrate(data) {
    if (!data || typeof data !== 'object') return emptyState();
    if (!Array.isArray(data.doctors)) data.doctors = [];
    if (!data.settings) data.settings = { lastImport: null, theme: 'auto' };
    data.doctors = data.doctors.map(normaliseDoctor);
    data.version = SCHEMA;
    return data;
  }

  /* The three kinds of contact a rep visits. `nameLabel` drives the form, since
     a medical store has a shop name rather than a person's name. */
  var TYPES = {
    doctor:      { label: 'Doctor',      plural: 'Doctors',      icon: '👨‍⚕️', nameLabel: 'Doctor name' },
    medical:     { label: 'Medical',     plural: 'Medicals',     icon: '💊',   nameLabel: 'Medical store name' },
    distributor: { label: 'Distributor', plural: 'Distributors', icon: '📦',   nameLabel: 'Distributor name' }
  };
  var TYPE_KEYS = ['doctor', 'medical', 'distributor'];

  /** Accepts anything a sheet might carry — "Chemist", "DIST.", "dr" etc. */
  function normaliseType(raw) {
    var s = P.searchKey(raw);
    if (!s) return '';
    if (/^(d|dr|doctor|doctors|physician)$/.test(s) || s.indexOf('doctor') !== -1) return 'doctor';
    if (s.indexOf('distrib') !== -1 || s.indexOf('stockist') !== -1 || /^dist/.test(s)) return 'distributor';
    if (s.indexOf('medical') !== -1 || s.indexOf('chemist') !== -1 || s.indexOf('pharmac') !== -1 ||
        s.indexOf('store') !== -1 || s.indexOf('retail') !== -1) return 'medical';
    return '';
  }

  /** Guarantees every field the UI reads exists, whatever the source. */
  function normaliseDoctor(d, i) {
    d = d || {};
    var slots = Array.isArray(d.slots) ? d.slots : [];
    // Doctors, medical stores and distributors are all visit targets with the
    // same shape — a day, a time, an area. One record, told apart by `type`.
    var type = TYPES[d.type] ? d.type : 'doctor';
    return {
      id: d.id || nextId(i),
      type: type,
      name: P.clean(d.name).toUpperCase(),
      hospital: P.clean(d.hospital),
      mobile: P.clean(d.mobile),
      area: P.clean(d.area).toUpperCase(),
      city: P.clean(d.city).toUpperCase(),
      state: P.clean(d.state).toUpperCase(),
      // Speciality only means anything for a doctor.
      speciality: type === 'doctor' ? (P.clean(d.speciality) || 'Orthopaedic') : P.clean(d.speciality),
      category: P.clean(d.category),
      slots: slots.map(function (s) {
        return {
          day: (s && s.day && P.DAY_LABEL[s.day]) ? s.day : 'ANY',
          time: s && s.time ? s.time : null,
          place: P.clean(s && s.place)
        };
      }),
      notes: typeof d.notes === 'string' ? d.notes : '',
      visits: Array.isArray(d.visits) ? d.visits.filter(function (v) { return v && v.date; }) : [],
      // Flag only — the visiting card image itself lives in IndexedDB (photos.js).
      card: !!d.card,
      updatedAt: d.updatedAt || Date.now()
    };
  }

  var idCounter = 0;
  function nextId() {
    idCounter++;
    return 'd_' + Date.now().toString(36) + '_' + idCounter;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // Quota is the realistic failure here — the user needs to know, silently
      // dropping their edits would be worse.
      alert('Could not save (storage full, or the browser is in private mode). ' +
            'Export a backup to free up space.\n\n' + e.message);
      return false;
    }
    listeners.forEach(function (fn) { fn(state); });
    return true;
  }

  function onChange(fn) { listeners.push(fn); }

  /* ---------- reads ---------- */

  function all() { return load().doctors; }

  function get(id) {
    return all().filter(function (d) { return d.id === id; })[0] || null;
  }

  function settings() { return load().settings; }

  /** Distinct non-empty values of a field, with counts, sorted by count desc. */
  function facet(field) {
    var counts = {};
    all().forEach(function (d) {
      var v = d[field];
      if (!v) return;
      counts[v] = (counts[v] || 0) + 1;
    });
    return Object.keys(counts)
      .map(function (k) { return { value: k, count: counts[k] }; })
      .sort(function (a, b) { return b.count - a.count || a.value.localeCompare(b.value); });
  }

  /**
   * Doctors visitable on `day`, flattened to one entry per matching slot so a
   * doctor with two Friday clinics shows twice. `ANY` day doctors are included
   * but flagged, letting the day view park them in their own section.
   */
  function forDay(day) {
    var rows = [];
    all().forEach(function (d) {
      d.slots.forEach(function (s) {
        if (s.day === day) rows.push({ doctor: d, slot: s, any: false });
        else if (s.day === 'ANY' && day !== 'ANY') rows.push({ doctor: d, slot: s, any: true });
      });
    });
    rows.sort(function (a, b) {
      var t = P.timeKey(a.slot.time) - P.timeKey(b.slot.time);
      return t || a.doctor.name.localeCompare(b.doctor.name);
    });
    return rows;
  }

  function dayCounts() {
    var counts = { ANY: 0 };
    P.DAYS.forEach(function (d) { counts[d] = 0; });
    all().forEach(function (d) {
      var seen = {};
      d.slots.forEach(function (s) {
        if (seen[s.day]) return;
        seen[s.day] = 1;
        counts[s.day] = (counts[s.day] || 0) + 1;
      });
    });
    return counts;
  }

  /** Free-text search across name, area, hospital, mobile, speciality, place. */
  function search(query) {
    var q = P.searchKey(query);
    if (!q) return all();
    var terms = q.split(' ').filter(Boolean);
    return all().filter(function (d) {
      var hay = P.searchKey([
        d.name, d.area, d.hospital, d.mobile, d.speciality, d.city, d.category, d.notes, TYPES[d.type].label,
        d.slots.map(function (s) { return P.DAY_LABEL[s.day] + ' ' + s.place; }).join(' ')
      ].join(' '));
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  /**
   * Doctors that look like the one being added — same name, plus a matching
   * mobile or area. Used to stop a visiting card silently creating a second
   * copy of someone already in the list.
   */
  function findSimilar(fields, excludeId) {
    var name = P.searchKey(fields.name);
    if (!name) return [];
    var mob = P.firstMobile(fields.mobile);
    var area = P.searchKey(fields.area);
    return all().filter(function (d) {
      if (excludeId && d.id === excludeId) return false;
      if (P.searchKey(d.name) !== name) return false;
      if (mob && P.firstMobile(d.mobile) === mob) return true;
      if (area && P.searchKey(d.area) === area) return true;
      return !mob && !area; // same name and nothing else to tell them apart
    });
  }

  function stats() {
    var docs = all();
    var scheduled = docs.filter(function (d) { return d.slots.length > 0; }).length;
    var areas = {};
    docs.forEach(function (d) { if (d.area) areas[d.area] = 1; });
    return {
      total: docs.length,
      scheduled: scheduled,
      unscheduled: docs.length - scheduled,
      areas: Object.keys(areas).length,
      byType: TYPE_KEYS.reduce(function (acc, k) {
        acc[k] = docs.filter(function (d) { return d.type === k; }).length;
        return acc;
      }, {}),
      today: forDay(P.todayKey()).filter(function (r) { return !r.any; }).length
    };
  }

  function lastVisit(d) {
    if (!d.visits || !d.visits.length) return null;
    return d.visits.slice().sort(function (a, b) { return b.date.localeCompare(a.date); })[0];
  }

  /* ---------- writes ---------- */

  function upsert(doctor) {
    load();
    var d = normaliseDoctor(doctor);
    d.updatedAt = Date.now();
    var idx = -1;
    for (var i = 0; i < state.doctors.length; i++) {
      if (state.doctors[i].id === d.id) { idx = i; break; }
    }
    if (idx === -1) state.doctors.push(d);
    else state.doctors[idx] = d;
    save();
    return d;
  }

  function create(fields) {
    return upsert(Object.assign({ id: nextId() }, fields || {}));
  }

  function remove(id) {
    load();
    state.doctors = state.doctors.filter(function (d) { return d.id !== id; });
    save();
    // Drop the visiting card too, otherwise it is orphaned in IndexedDB forever.
    if (DD.photos) DD.photos.del(id).catch(function () {});
  }

  /** Called after a card image is stored or removed for a doctor. */
  function setCard(id, has) {
    var d = get(id);
    if (!d) return null;
    d.card = !!has;
    return upsert(d);
  }

  function addVisit(id, note) {
    var d = get(id);
    if (!d) return null;
    d.visits.push({ date: P.isoDate(), note: P.clean(note) });
    return upsert(d);
  }

  function removeVisit(id, index) {
    var d = get(id);
    if (!d) return null;
    d.visits.splice(index, 1);
    return upsert(d);
  }

  /**
   * Identity for merging. Two keys are tried in order:
   *   1. name + mobile  — the strongest signal
   *   2. name + area    — catches a doctor whose number changed or is blank
   *
   * Mobile alone is deliberately NOT a key: clinic numbers are shared, and two
   * different doctors at one hospital would collapse into a single record.
   */
  function keyNameMobile(d) {
    var mob = P.firstMobile(d.mobile);
    return mob ? 'nm:' + P.searchKey(d.name) + '|' + mob : null;
  }

  function keyNameArea(d) {
    return 'na:' + P.searchKey(d.name) + '|' + P.searchKey(d.area);
  }

  /**
   * @param incoming array of doctor-shaped objects
   * @param mode 'replace' wipes everything first; 'merge' keeps local edits
   * @returns {{added:number, updated:number, total:number, idMap:Object}}
   *
   * idMap maps each incoming record's original id to the id it ended up under.
   * A backup's visiting cards are keyed by the old ids, so without this map the
   * photos would be orphaned the moment merge assigns fresh ids.
   */
  function importDoctors(incoming, mode) {
    load();
    var added = 0, updated = 0;
    var idMap = {};

    if (mode === 'replace') {
      state.doctors = incoming.map(function (d, i) {
        var out = normaliseDoctor(d, i);
        if (d && d.id) idMap[d.id] = out.id;
        return out;
      });
      added = state.doctors.length;
    } else {
      var byNameMobile = {};
      var byNameArea = {};
      var register = function (d, i) {
        var k1 = keyNameMobile(d);
        if (k1 && byNameMobile[k1] === undefined) byNameMobile[k1] = i;
        var k2 = keyNameArea(d);
        if (byNameArea[k2] === undefined) byNameArea[k2] = i;
      };
      state.doctors.forEach(register);

      incoming.forEach(function (raw) {
        var originalId = raw && raw.id;
        var inc = normaliseDoctor(raw);
        var k1 = keyNameMobile(inc);
        var at = k1 !== null ? byNameMobile[k1] : undefined;
        if (at === undefined) at = byNameArea[keyNameArea(inc)];

        if (at === undefined) {
          inc.id = nextId();
          if (originalId) idMap[originalId] = inc.id;
          register(inc, state.doctors.length);
          state.doctors.push(inc);
          added++;
          return;
        }
        var existing = state.doctors[at];
        if (originalId) idMap[originalId] = existing.id;
        // Sheet wins on identity fields; the device wins on everything the user
        // filled in here (slots, notes, visits) unless the sheet supplies slots
        // and the device has none.
        state.doctors[at] = Object.assign({}, existing, {
          name: inc.name || existing.name,
          hospital: inc.hospital || existing.hospital,
          mobile: inc.mobile || existing.mobile,
          area: inc.area || existing.area,
          city: inc.city || existing.city,
          state: inc.state || existing.state,
          type: inc.type || existing.type,
          speciality: inc.speciality || existing.speciality,
          category: inc.category || existing.category,
          slots: existing.slots.length ? existing.slots : inc.slots,
          notes: existing.notes || inc.notes,
          card: existing.card || inc.card,
          updatedAt: Date.now()
        });
        // The merge may have filled in a blank mobile — index the new key so a
        // later row for the same doctor still matches.
        register(state.doctors[at], at);
        updated++;
      });
    }

    state.settings.lastImport = new Date().toISOString();
    save();
    return { added: added, updated: updated, total: state.doctors.length, idMap: idMap };
  }

  function exportJSON() {
    load();
    return JSON.stringify({
      version: SCHEMA,
      exportedAt: new Date().toISOString(),
      doctors: state.doctors,
      settings: state.settings
    }, null, 2);
  }

  function clearAll() {
    state = emptyState();
    save();
    if (DD.photos) DD.photos.clear().catch(function () {});
  }

  DD.store = {
    TYPES: TYPES,
    TYPE_KEYS: TYPE_KEYS,
    normaliseType: normaliseType,
    KEY: KEY,
    load: load,
    onChange: onChange,
    all: all,
    get: get,
    settings: settings,
    facet: facet,
    forDay: forDay,
    dayCounts: dayCounts,
    search: search,
    findSimilar: findSimilar,
    stats: stats,
    lastVisit: lastVisit,
    nextId: nextId,
    upsert: upsert,
    create: create,
    remove: remove,
    setCard: setCard,
    addVisit: addVisit,
    removeVisit: removeVisit,
    importDoctors: importDoctors,
    exportJSON: exportJSON,
    clearAll: clearAll,
    save: save
  };
})(window.DD = window.DD || {});
