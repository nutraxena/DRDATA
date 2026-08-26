/* Dr-Diary — screen rendering. Every view returns an HTML string; app.js owns
   routing and event delegation. */
(function (DD) {
  'use strict';

  var P = DD.parse;
  var S = DD.store;

  /** Escape text going into HTML. Doctor names and notes are user data. */
  function h(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** Escape for use inside a URL hash segment. */
  function seg(s) { return encodeURIComponent(String(s)); }

  function title(s) { return h(P.titleCase(s)); }

  /* ---------- shared fragments ---------- */

  function actionRow(d, opts) {
    opts = opts || {};
    var mob = P.firstMobile(d.mobile);
    var last = S.lastVisit(d);
    var doneToday = last && last.date === P.isoDate();
    var mapQ = encodeURIComponent([d.hospital, d.area, d.city || 'Ahmedabad'].filter(Boolean).join(' '));
    return '' +
      '<div class="actions">' +
        (mob
          ? '<a class="act wa" href="https://wa.me/91' + h(mob) + '" target="_blank" rel="noopener" data-stop="1">💬 WhatsApp</a>'
          : '<button class="act wa" disabled>💬 No number</button>') +
        '<a class="act map" href="https://www.google.com/maps/search/?api=1&query=' + mapQ + '" target="_blank" rel="noopener" data-stop="1">📍 Map</a>' +
        // Edit sits on every card so a doctor can be corrected straight from the
        // day or area list, without opening the detail page first.
        '<button class="act edit" data-action="edit-doctor" data-id="' + h(d.id) + '" data-stop="1">✏️ Edit</button>' +
        (opts.hideDone ? '' :
          '<button class="act done' + (doneToday ? ' is-done' : '') + '" data-action="visit" data-id="' + h(d.id) + '" data-stop="1">' +
            (doneToday ? '✅ Done today' : '✓ Visit done') +
          '</button>') +
      '</div>';
  }

  /**
   * Short "which days, what time" line for the compact views. Consecutive days
   * collapse, so a Tue-Fri doctor reads "Tue–Fri 5:00 PM" instead of four
   * separate chips.
   */
  function slotSummary(d) {
    if (!d.slots.length) return '';
    return groupSlots(d.slots).map(function (g) {
      return daysLabel(g.days, true) + (g.time ? ' ' + P.formatTime(g.time) : '');
    }).join(' · ');
  }

  /** Coloured pill showing whether this is a doctor, medical or distributor. */
  function typeBadge(d) {
    var meta = S.TYPES[d.type] || S.TYPES.doctor;
    return '<span class="tbadge t-' + h(d.type) + '">' + meta.icon + ' ' + h(meta.label) + '</span>';
  }

  /** Small status icons — notes, saved card, visited. */
  function markers(d) {
    var out = '';
    if (d.notes && d.notes.trim()) out += '<span class="mk" title="Has a note">📝</span>';
    if (d.card) out += '<span class="mk" title="Visiting card saved">🪪</span>';
    if (d.visits && d.visits.length) out += '<span class="mk" title="Visited before">✅</span>';
    return out ? '<span class="markers">' + out + '</span>' : '';
  }

  /** Compact single row — name, day/time, area. Tap opens the doctor. */
  function doctorRow(d) {
    var when = slotSummary(d);
    return '<div class="docrow" data-href="#/dr/' + seg(d.id) + '" role="link" tabindex="0">' +
      '<div class="docrow-main">' +
        '<div class="docrow-name">' + title(d.name) + markers(d) + '</div>' +
        '<div class="docrow-sub">' + typeBadge(d) + (d.area ? title(d.area) : '—') +
          (d.hospital ? '<span class="dot">•</span>' + h(d.hospital) : '') + '</div>' +
      '</div>' +
      '<div class="docrow-when">' +
        (when ? '<span class="when-day">' + h(when) + '</span>'
              : '<span class="when-none">No day set</span>') +
      '</div>' +
    '</div>';
  }

  /** Grid tile — name, day and time, markers. Tap opens the doctor. */
  function doctorTile(d) {
    var when = slotSummary(d);
    return '<div class="doctile" data-href="#/dr/' + seg(d.id) + '" role="link" tabindex="0">' +
      '<div class="doctile-name">' + title(d.name) + '</div>' +
      typeBadge(d) +
      (d.area ? '<div class="doctile-area">' + title(d.area) + '</div>' : '') +
      '<div class="doctile-when' + (when ? '' : ' none') + '">' +
        h(when || 'No day set') + '</div>' +
      '<div class="doctile-mk">' + markers(d) + '</div>' +
    '</div>';
  }

  /** One doctor card. `slot` renders the time badge for day/area listings. */
  function doctorCard(d, slot, opts) {
    opts = opts || {};
    var last = S.lastVisit(d);
    var badge = '';
    if (slot) {
      badge = '<span class="timebadge' + (slot.time ? '' : ' any') + '">🕐 ' + h(P.formatTime(slot.time)) + '</span>';
    }
    var place = slot && slot.place ? slot.place : d.hospital;
    // "Vastral Clinic • Vastral" reads badly — drop the area when the place
    // already names it (or vice versa).
    var showArea = d.area && P.searchKey(place).indexOf(P.searchKey(d.area)) === -1;
    var meta = [place, showArea ? P.titleCase(d.area) : '']
      .filter(Boolean).map(h).join('<span class="dot">•</span>');

    var tags = [];
    if (d.type !== 'doctor') tags.push(typeBadge(d));
    if (opts.showDays !== false && d.slots.length) {
      var seen = {};
      d.slots.forEach(function (s) {
        if (seen[s.day]) return;
        seen[s.day] = 1;
        tags.push('<span class="tag day">' + h(P.DAY_SHORT[s.day]) +
          (s.time ? ' ' + h(P.formatTime(s.time)) : '') + '</span>');
      });
    } else if (opts.showDays !== false) {
      tags.push('<span class="tag nodays">No day set</span>');
    }
    if (last) tags.push('<span class="tag visit">Visit: ' + h(P.relativeDays(last.date)) + '</span>');

    // A div, not an anchor: the action row contains its own links and buttons,
    // and nesting interactive elements inside <a> is invalid HTML. app.js turns
    // data-href into navigation on click.
    return '' +
      '<div class="card" data-href="#/dr/' + seg(d.id) + '" role="link" tabindex="0">' +
        '<div class="card-top">' +
          '<div>' +
            '<div class="card-name">' + title(d.name) + markers(d) + '</div>' +
            (meta ? '<div class="card-meta">' + meta + '</div>' : '') +
          '</div>' +
          badge +
        '</div>' +
        (tags.length ? '<div class="tags">' + tags.join('') + '</div>' : '') +
        actionRow(d, opts) +
      '</div>';
  }

  /** "1 doctor" / "4 doctors" */
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function emptyBox(heading, body, cta) {
    return '<div class="empty"><h3>' + h(heading) + '</h3><p>' + body + '</p>' + (cta || '') + '</div>';
  }

  var IMPORT_CTA = '<a class="btn primary" href="#/data">Import Excel</a>';

  /* ---------- home ---------- */

  function home() {
    var st = S.stats();
    if (!st.total) {
      return emptyBox('Nothing added yet',
        'Import your Excel sheet (.xlsx / .csv) — a <b>NAME</b> column is enough; add <b>TYPE</b>, <b>MOBILE NO</b> and <b>AREA</b> if you have them. ' +
        'You can set each doctor\u2019s day and time afterwards.', IMPORT_CTA);
    }

    var today = P.todayKey();
    var rows = S.forDay(today);
    var fixed = rows.filter(function (r) { return !r.any; });
    var counts = S.dayCounts();

    var todayHtml;
    if (!fixed.length) {
      todayHtml = '<div class="empty" style="padding:22px"><p style="margin:0">' +
        'Nothing fixed for today (' + h(P.DAY_LABEL[today]) + ').' +
        (counts.ANY ? ' ' + counts.ANY + ' are marked Any day.' : '') +
        '</p></div>';
    } else {
      todayHtml = fixed.map(function (r) { return doctorCard(r.doctor, r.slot, { showDays: false }); }).join('');
    }

    var chips = P.DAYS.concat(['ANY']).map(function (day) {
      var n = counts[day] || 0;
      var cls = 'daychip' + (day === today ? ' today' : '') + (n ? '' : ' zero');
      return '<a class="' + cls + '" href="#/day/' + day + '">' +
        '<strong>' + h(P.DAY_SHORT[day]) + '</strong>' +
        '<em>' + n + ' dr</em></a>';
    }).join('');

    return '' +
      '<section class="section">' +
        '<div class="stats">' +
          '<div class="stat"><b>' + st.total + '</b><span>Contacts</span></div>' +
          '<div class="stat"><b>' + st.today + '</b><span>Today</span></div>' +
          '<div class="stat"><b>' + st.areas + '</b><span>Areas</span></div>' +
          '<div class="stat' + (st.unscheduled ? ' warn' : '') + '"><b>' + st.unscheduled + '</b><span>No day</span></div>' +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Today’s plan — ' + h(P.DAY_LABEL[today]) + '</h2>' +
          '<a href="#/day/' + today + '">Full day →</a></div>' +
        todayHtml +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Day wise</h2></div>' +
        '<div class="daygrid">' + chips + '</div>' +
      '</section>' +

      (st.unscheduled
        ? '<section class="section"><div class="warnbox">' +
            '<b>' + plural(st.unscheduled, 'contact') + '</b> ' + (st.unscheduled === 1 ? 'has' : 'have') + ' no day or time set yet — ' +
            '<a href="#/doctors?filter=noday">set them here</a> so they show up in the day views.' +
          '</div></section>'
        : '') +

      '<section class="section">' +
        '<div class="section-head"><h2>Top areas</h2><a href="#/areas">All areas →</a></div>' +
        S.facet('area').slice(0, 6).map(function (a) {
          return '<a class="card" href="#/area/' + seg(a.value) + '">' +
            '<div class="card-top"><div class="card-name">📍 ' + title(a.value) + '</div>' +
            '<span class="timebadge any">' + a.count + ' dr</span></div></a>';
        }).join('') +
      '</section>';
  }

  /* ---------- days ---------- */

  function days() {
    var counts = S.dayCounts();
    var today = P.todayKey();
    return '<h1 class="page-title">Days</h1>' +
      P.DAYS.concat(['ANY']).map(function (day) {
        return '<a class="card" href="#/day/' + day + '">' +
          '<div class="card-top">' +
            '<div><div class="card-name">' + h(P.DAY_LABEL[day]) +
              (day === today ? ' <span class="tag day">Today</span>' : '') + '</div></div>' +
            '<span class="timebadge' + (counts[day] ? '' : ' any') + '">' + (counts[day] || 0) + ' dr</span>' +
          '</div></a>';
      }).join('');
  }

  function day(dayKey) {
    if (!P.DAY_LABEL[dayKey]) return notFound('Day');
    var rows = S.forDay(dayKey);
    var fixed = rows.filter(function (r) { return !r.any; });
    var anyRows = rows.filter(function (r) { return r.any; });

    var body;
    if (!fixed.length) {
      body = emptyBox(P.DAY_LABEL[dayKey] + ' has nothing scheduled yet',
        'Open a contact and add a <b>' + h(P.DAY_SHORT[dayKey]) + '</b> slot with a time — ' +
        'they will appear here in time order.',
        '<a class="btn primary" href="#/doctors">Open the list</a>');
    } else {
      // Group by area, but order the groups by their earliest appointment so the
      // page reads as the day's route in the order you would actually drive it.
      var groups = {};
      fixed.forEach(function (r) {
        var key = r.slot.place || r.doctor.area || 'Other';
        (groups[key] = groups[key] || []).push(r);
      });
      body = Object.keys(groups).sort(function (a, b) {
        var ta = P.timeKey(groups[a][0].slot.time);
        var tb = P.timeKey(groups[b][0].slot.time);
        return ta - tb || a.localeCompare(b);
      }).map(function (area) {
        return '<div class="grouphead">📍 ' + title(area) + ' (' + groups[area].length + ')</div>' +
          groups[area].map(function (r) { return doctorCard(r.doctor, r.slot, { showDays: false }); }).join('');
      }).join('');
    }

    var anyHtml = anyRows.length
      ? '<details class="anyblock"><summary>+ ' + plural(anyRows.length, 'contact') + ' available Any day</summary>' +
          anyRows.map(function (r) { return doctorCard(r.doctor, r.slot, { showDays: false }); }).join('') +
        '</details>'
      : '';

    return '<a class="backlink" href="#/days">← All days</a>' +
      '<h1 class="page-title">' + h(P.DAY_LABEL[dayKey]) +
        '<span class="page-sub">' + plural(fixed.length, 'visit') + '</span></h1>' +
      body + anyHtml;
  }

  /* ---------- areas ---------- */

  function areas() {
    var list = S.facet('area');
    if (!list.length) return emptyBox('No areas found', 'Import your sheet first.', IMPORT_CTA);
    return '<h1 class="page-title">Areas<span class="page-sub">' + list.length + '</span></h1>' +
      list.map(function (a) {
        return '<a class="card" href="#/area/' + seg(a.value) + '">' +
          '<div class="card-top"><div class="card-name">📍 ' + title(a.value) + '</div>' +
          '<span class="timebadge any">' + a.count + ' dr</span></div></a>';
      }).join('');
  }

  function area(name) {
    var docs = S.all().filter(function (d) { return d.area === name; });
    if (!docs.length) return notFound('Area');

    // Within an area, group by day so you can see what a Friday round looks like.
    var byDay = {};
    var noDay = [];
    docs.forEach(function (d) {
      if (!d.slots.length) { noDay.push(d); return; }
      d.slots.forEach(function (s) { (byDay[s.day] = byDay[s.day] || []).push({ doctor: d, slot: s }); });
    });

    var order = P.DAYS.concat(['ANY']).filter(function (k) { return byDay[k]; });
    var body = order.map(function (k) {
      var rows = byDay[k].sort(function (a, b) { return P.timeKey(a.slot.time) - P.timeKey(b.slot.time); });
      return '<div class="grouphead">' + h(P.DAY_LABEL[k]) + ' (' + rows.length + ')</div>' +
        rows.map(function (r) { return doctorCard(r.doctor, r.slot, { showDays: false }); }).join('');
    }).join('');

    if (noDay.length) {
      body += '<div class="grouphead">No day set (' + noDay.length + ')</div>' +
        noDay.map(function (d) { return doctorCard(d, null); }).join('');
    }

    return '<a class="backlink" href="#/areas">← All areas</a>' +
      '<h1 class="page-title">📍 ' + title(name) + '<span class="page-sub">' + plural(docs.length, 'contact') + '</span></h1>' +
      body;
  }

  /* ---------- doctors list ---------- */

  var filterState = { type: '', area: '', speciality: '', day: '', only: '' };

  function doctors(query) {
    var docs = query ? S.search(query) : S.all();

    if (filterState.type) docs = docs.filter(function (d) { return d.type === filterState.type; });
    if (filterState.area) docs = docs.filter(function (d) { return d.area === filterState.area; });
    if (filterState.speciality) docs = docs.filter(function (d) { return d.speciality === filterState.speciality; });
    if (filterState.day) {
      docs = docs.filter(function (d) {
        return d.slots.some(function (s) { return s.day === filterState.day; });
      });
    }
    if (filterState.only === 'noday') docs = docs.filter(function (d) { return !d.slots.length; });
    if (filterState.only === 'novisit') docs = docs.filter(function (d) { return !d.visits.length; });

    docs = docs.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });

    var opt = function (list, sel, blank) {
      return '<option value="">' + h(blank) + '</option>' + list.map(function (x) {
        var v = x.value === undefined ? x : x.value;
        var label = x.count !== undefined ? P.titleCase(v) + ' (' + x.count + ')' : v;
        return '<option value="' + h(v) + '"' + (sel === v ? ' selected' : '') + '>' + h(label) + '</option>';
      }).join('');
    };

    // Type is the first thing you narrow by, so it gets its own chip row rather
    // than being buried in a dropdown with the rest.
    var counts = S.stats().byType;
    var typeChips = '<div class="typechips">' +
      '<button class="tchip' + (filterState.type ? '' : ' on') + '" data-action="set-type" data-type="">' +
        'All <em>' + S.all().length + '</em></button>' +
      S.TYPE_KEYS.map(function (k) {
        var meta = S.TYPES[k];
        return '<button class="tchip t-' + k + (filterState.type === k ? ' on' : '') +
          '" data-action="set-type" data-type="' + k + '">' +
          meta.icon + ' ' + h(meta.plural) + ' <em>' + (counts[k] || 0) + '</em></button>';
      }).join('') +
    '</div>';

    var filters = typeChips + '<div class="filters">' +
      '<select data-filter="area">' + opt(S.facet('area'), filterState.area, 'All areas') + '</select>' +
      (filterState.type && filterState.type !== 'doctor' ? '' :
        '<select data-filter="speciality">' + opt(S.facet('speciality'), filterState.speciality, 'All specialities') + '</select>') +
      '<select data-filter="day">' +
        '<option value="">Any day filter</option>' +
        P.DAYS.concat(['ANY']).map(function (d) {
          return '<option value="' + d + '"' + (filterState.day === d ? ' selected' : '') + '>' + h(P.DAY_LABEL[d]) + '</option>';
        }).join('') +
      '</select>' +
      '<select data-filter="only">' +
        '<option value="">All</option>' +
        '<option value="noday"' + (filterState.only === 'noday' ? ' selected' : '') + '>No day set</option>' +
        '<option value="novisit"' + (filterState.only === 'novisit' ? ' selected' : '') + '>Never visited</option>' +
      '</select>' +
    '</div>';

    var mode = S.settings().docView || 'details';
    var list;
    if (!docs.length) {
      list = emptyBox('Nothing found', 'Try a different search or filter.',
        '<button class="btn" data-action="clear-filters">Clear filters</button>');
    } else if (mode === 'list') {
      list = '<div class="doclist">' + docs.map(doctorRow).join('') + '</div>';
    } else if (mode === 'icon') {
      list = '<div class="docgrid">' + docs.map(doctorTile).join('') + '</div>';
    } else {
      list = docs.map(function (d) { return doctorCard(d, null); }).join('');
    }

    return '<h1 class="page-title">Contacts<span class="page-sub">' + docs.length + ' / ' + S.all().length + '</span></h1>' +
      '<section class="section">' + viewToggle(mode) + filters + '</section>' +
      list;
  }

  /** List / Details / Icon switcher for the doctors screen. */
  function viewToggle(mode) {
    var opt = function (key, icon, label) {
      return '<button class="vt' + (mode === key ? ' on' : '') + '" data-action="set-view" data-mode="' + key + '"' +
        ' aria-pressed="' + (mode === key ? 'true' : 'false') + '" title="' + h(label) + '">' +
        '<span class="vt-ico">' + icon + '</span><span>' + h(label) + '</span></button>';
    };
    return '<div class="viewtoggle" role="group" aria-label="View">' +
      opt('list', '☰', 'List') +
      opt('details', '▤', 'Details') +
      opt('icon', '▦', 'Icon') +
    '</div>';
  }

  /* ---------- doctor detail ---------- */

  function doctor(id) {
    var d = S.get(id);
    if (!d) return notFound('Doctor');

    // Show the schedule the way it was entered — one line per time/clinic,
    // listing every day it applies to.
    var slots = d.slots.length
      ? groupSlots(d.slots).sort(function (a, b) {
          var key = function (g) {
            var first = g.days[0];
            return first === 'ANY' ? 7 : P.DAYS.indexOf(first);
          };
          return key(a) - key(b) || P.timeKey(a.time) - P.timeKey(b.time);
        }).map(function (g) {
          return '<div class="card" style="margin-bottom:8px">' +
            '<div class="card-top">' +
              '<div><div class="card-name">' + h(daysLabel(g.days)) + '</div>' +
                (g.place ? '<div class="card-meta">' + title(g.place) + '</div>' : '') +
              '</div>' +
              '<span class="timebadge' + (g.time ? '' : ' any') + '">🕐 ' + h(P.formatTime(g.time)) + '</span>' +
            '</div></div>';
        }).join('')
      : '<div class="warnbox">This doctor has <b>no day or time set</b>, so they will not appear in any day view. ' +
        'Tap <b>Set day &amp; time</b> below.</div>';

    var visits = d.visits.slice().sort(function (a, b) { return b.date.localeCompare(a.date); });
    var visitHtml = visits.length
      ? '<ul class="visitlog">' + visits.map(function (v, i) {
          var realIdx = d.visits.indexOf(v);
          return '<li><div><div class="vdate">' + h(v.date) + ' · ' + h(P.relativeDays(v.date)) + '</div>' +
            (v.note ? '<div class="vnote">' + h(v.note) + '</div>' : '') + '</div>' +
            '<button class="vdel" data-action="del-visit" data-id="' + h(d.id) + '" data-index="' + realIdx + '" aria-label="Delete visit">🗑</button></li>';
        }).join('') + '</ul>'
      : '<p class="hint">No visits recorded yet.</p>';

    return '' +
      '<a class="backlink" href="#/doctors">← Doctors</a>' +
      '<div class="detail-head">' +
        '<h1>' + title(d.name) + '</h1>' +
        '<div class="sub">' + [d.hospital, P.titleCase(d.area)].filter(Boolean).map(h).join(' · ') + '</div>' +
        '<dl class="kv">' +
          (d.mobile ? '<dt>Mobile</dt><dd>' + h(d.mobile) + '</dd>' : '') +
          '<dt>Area</dt><dd>' + (d.area ? title(d.area) : '—') + '</dd>' +
          '<dt>Speciality</dt><dd>' + h(d.speciality || '—') + '</dd>' +
          (d.category ? '<dt>Category</dt><dd>' + h(d.category) + '</dd>' : '') +
          (d.city ? '<dt>City</dt><dd>' + title(d.city) + '</dd>' : '') +
        '</dl>' +
        actionRow(d) +
      '</div>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Visit days &amp; time</h2></div>' +
        slots +
        '<button class="btn primary wide" data-action="edit-doctor" data-id="' + h(d.id) + '">🕐 Set day &amp; time</button>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Visiting card</h2></div>' +
        // Filled in asynchronously once the blob is read out of IndexedDB.
        '<div id="card-slot" data-doctor="' + h(d.id) + '">' +
          (d.card ? '<p class="hint">Loading card…</p>' : cardEmpty(d.id)) +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Notes</h2></div>' +
        '<textarea data-action="notes" data-id="' + h(d.id) + '" placeholder="Product discuss kiya, next follow-up…">' + h(d.notes) + '</textarea>' +
        '<p class="hint">Saves automatically.</p>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Visit history</h2><span class="page-sub">' + visits.length + '</span></div>' +
        visitHtml +
      '</section>' +

      '<section class="section">' +
        '<button class="btn primary wide" data-action="edit-doctor" data-id="' + h(d.id) + '">✏️ Edit details</button>' +
      '</section>';
  }

  /** Card section when the doctor has no visiting card saved yet. */
  function cardEmpty(id) {
    return '<div class="card" style="text-align:center">' +
      '<p class="hint" style="margin-top:0">No visiting card saved for this doctor.</p>' +
      '<div class="btnrow">' +
        '<button class="btn primary" data-action="card-camera" data-id="' + h(id) + '">📷 Camera</button>' +
        '<button class="btn" data-action="card-gallery" data-id="' + h(id) + '">🖼 Gallery</button>' +
      '</div></div>';
  }

  /** Card section once the image blob is available. */
  function cardShown(id, url, sizeLabel) {
    return '<div class="cardshot">' +
      '<img src="' + h(url) + '" alt="Visiting card" data-action="zoom-card">' +
      '<div class="btnrow" style="margin-top:9px">' +
        '<button class="btn" data-action="card-camera" data-id="' + h(id) + '">🔄 Replace</button>' +
        '<button class="btn danger" data-action="card-delete" data-id="' + h(id) + '">🗑 Remove photo</button>' +
      '</div>' +
      '<p class="hint">Tap to enlarge' + (sizeLabel ? ' · ' + h(sizeLabel) : '') + '</p>' +
    '</div>';
  }

  /* ---------- modal forms ---------- */

  /**
   * Slots are stored one day at a time so day views stay simple. For editing
   * and display we regroup them: every slot sharing a time and place becomes a
   * single entry holding all its days, e.g. {days:[TUE,THU], time:'17:00'}.
   */
  function groupSlots(slots) {
    var groups = {};
    var order = [];
    (slots || []).forEach(function (s) {
      var k = (s.time || '') + '|' + (s.place || '');
      if (!groups[k]) {
        groups[k] = { days: [], time: s.time || null, place: s.place || '' };
        order.push(k);
      }
      if (groups[k].days.indexOf(s.day) === -1) groups[k].days.push(s.day);
    });
    return order.map(function (k) {
      groups[k].days.sort(function (a, b) { return P.DAYS.indexOf(a) - P.DAYS.indexOf(b); });
      return groups[k];
    });
  }

  /**
   * "Mon, Wed, Sat" — but three or more in a row read better as a span, so
   * Tue,Wed,Thu,Fri becomes "Tue–Fri".
   */
  function daysLabel(days, short) {
    if (!days || !days.length) return '';
    if (days.indexOf('ANY') !== -1) return short ? 'Any' : 'Any Day';
    var name = short ? P.DAY_SHORT : P.DAY_LABEL;
    var idx = days.map(function (d) { return P.DAYS.indexOf(d); })
                  .filter(function (n) { return n >= 0; })
                  .sort(function (a, b) { return a - b; });
    var parts = [];
    var i = 0;
    while (i < idx.length) {
      var j = i;
      while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
      if (j - i + 1 >= 3) parts.push(name[P.DAYS[idx[i]]] + '–' + name[P.DAYS[idx[j]]]);
      else for (var t = i; t <= j; t++) parts.push(name[P.DAYS[idx[t]]]);
      i = j + 1;
    }
    return parts.join(', ');
  }

  /**
   * One visiting slot. Days are tappable chips rather than a dropdown, because
   * a doctor is commonly available on unrelated days — Tue and Thu, or Mon,
   * Wed and Sat — which a single-choice control cannot express.
   */
  function slotRow(s) {
    s = s || { days: [P.todayKey()], time: '', place: '' };
    var days = s.days || [];
    var chip = function (key, label, extra) {
      var on = days.indexOf(key) !== -1;
      return '<label class="daychip-pick' + (on ? ' on' : '') + (extra ? ' ' + extra : '') + '">' +
        '<input type="checkbox" name="day" value="' + key + '"' + (on ? ' checked' : '') + '>' +
        '<span>' + h(label) + '</span></label>';
    };

    return '<div class="slotrow">' +
      '<div class="daypick">' +
        P.DAYS.map(function (k) { return chip(k, P.DAY_SHORT[k]); }).join('') +
        chip('ANY', 'Any Day', 'wide') +
      '</div>' +
      '<div class="slotmeta">' +
        '<input type="time" name="time" value="' + h(s.time || '') + '" aria-label="Time">' +
        '<button type="button" class="del" data-action="del-slot" aria-label="Remove this row">×</button>' +
      '</div>' +
      '<input class="place" type="text" name="place" value="' + h(s.place || '') + '" placeholder="Clinic / hospital (optional)">' +
    '</div>';
  }

  /** The days-and-time block embedded in the doctor form. */
  function slotsSection(d) {
    var rows = groupSlots(d && d.slots);
    if (!rows.length) rows = [{ days: [P.todayKey()], time: '', place: '' }];
    return '<div class="formgroup">' +
      '<h3 class="formgroup-head">🕐 Which days and what time</h3>' +
      '<p class="hint" style="margin-top:0">Tap every day this doctor is available — ' +
      'both Tue and Thu, or Mon+Wed+Sat, as many as you need. Leave the time blank for "Any time". ' +
      'Add another row below for a different time or clinic.</p>' +
      '<div data-slots>' + rows.map(slotRow).join('') + '</div>' +
      '<button type="button" class="btn wide" data-action="add-slot">+ Add another time / clinic</button>' +
    '</div>';
  }

  /**
   * @param d       doctor being edited, or null for a new one
   * @param cardURL object URL of a just-captured visiting card, shown above the
   *                fields so the details can be copied straight off it
   */
  /** A fresh, empty record of the given type — used by the add flow. */
  function blankRecord(type) {
    return { id: '', type: S.TYPES[type] ? type : 'doctor', name: '', hospital: '', mobile: '',
             area: '', city: 'AHMEDABAD', state: 'GUJARAT',
             speciality: type === 'doctor' ? 'Orthopaedic' : '', category: '', notes: '', slots: [] };
  }

  function doctorForm(d, cardURL) {
    d = d || { id: '', type: 'doctor', name: '', hospital: '', mobile: '', area: '', city: 'AHMEDABAD',
               state: 'GUJARAT', speciality: 'Orthopaedic', category: '', notes: '', slots: [] };
    var type = S.TYPES[d.type] ? d.type : 'doctor';
    var meta = S.TYPES[type];
    var areaList = S.facet('area').map(function (a) { return '<option value="' + h(a.value) + '">'; }).join('');

    // Picking the type first changes the labels below it, so it sits at the top.
    var typePick = '<div class="field"><label>Type</label><div class="typepick">' +
      S.TYPE_KEYS.map(function (k) {
        var m = S.TYPES[k];
        return '<label class="typeopt t-' + k + (type === k ? ' on' : '') + '">' +
          '<input type="radio" name="type" value="' + k + '"' + (type === k ? ' checked' : '') + '>' +
          '<span>' + m.icon + '<br>' + h(m.label) + '</span></label>';
      }).join('') +
    '</div></div>';

    var placeLabel = type === 'doctor' ? 'Hospital / clinic'
      : (type === 'medical' ? 'Shop / address line' : 'Firm / address line');

    return '<form data-form="doctor" data-id="' + h(d.id) + '"' + (cardURL ? ' data-card="1"' : '') + '>' +
      (cardURL
        ? '<div class="cardshot cardshot-form">' +
            '<img src="' + h(cardURL) + '" alt="Visiting card" data-action="zoom-card">' +
            '<p class="hint">Tap the photo to enlarge. It is saved with this contact.</p>' +
          '</div>'
        : '') +
      typePick +
      '<div class="field"><label for="f-name">' + h(meta.nameLabel) + ' *</label>' +
        '<input id="f-name" name="name" type="text" value="' + h(d.name) + '" required placeholder="' +
        (type === 'doctor' ? 'DR VIKAS PATEL' : type === 'medical' ? 'SHREEJI MEDICAL STORE' : 'PATEL PHARMA DISTRIBUTORS') + '"></div>' +
      '<div class="field"><label for="f-hosp">' + h(placeLabel) + '</label>' +
        '<input id="f-hosp" name="hospital" type="text" value="' + h(d.hospital) + '"></div>' +
      '<div class="field"><label for="f-mob">Mobile</label>' +
        '<input id="f-mob" name="mobile" type="tel" value="' + h(d.mobile) + '" placeholder="9876543210"></div>' +
      '<div class="field"><label for="f-area">Area</label>' +
        '<input id="f-area" name="area" type="text" value="' + h(d.area) + '" list="area-list" placeholder="VASTRAL">' +
        '<datalist id="area-list">' + areaList + '</datalist></div>' +
      '<div class="field-row">' +
        '<div class="field"' + (type === 'doctor' ? '' : ' hidden') + '><label for="f-spl">Speciality</label>' +
          '<input id="f-spl" name="speciality" type="text" value="' + h(d.speciality) + '"></div>' +
        '<div class="field"><label for="f-cat">Category</label>' +
          '<input id="f-cat" name="category" type="text" value="' + h(d.category) + '" placeholder="A / B / C"></div>' +
      '</div>' +
      '<div class="field-row">' +
        '<div class="field"><label for="f-city">City</label>' +
          '<input id="f-city" name="city" type="text" value="' + h(d.city) + '"></div>' +
        '<div class="field"><label for="f-state">State</label>' +
          '<input id="f-state" name="state" type="text" value="' + h(d.state) + '"></div>' +
      '</div>' +
      '<div class="field"><label for="f-notes">Note</label>' +
        '<textarea id="f-notes" name="notes" placeholder="Which products they use, who to meet, anything worth remembering…">' +
          h(d.notes || '') + '</textarea></div>' +
      // Days and time live in the same form, so a doctor can be fully set up
      // from any list — and from the very first save of a new doctor.
      slotsSection(d) +
      '<div class="btnrow">' +
        '<button type="submit" class="btn primary">Save</button>' +
        '<button type="button" class="btn" data-close="1">Cancel</button>' +
      '</div>' +
      // Only for an existing record, and deliberately understated — this exists
      // for a card scanned by mistake, not as a routine action.
      (d.id
        ? '<p style="text-align:center;margin:16px 0 0">' +
            '<button type="button" class="linkbtn" data-action="delete-doctor" data-id="' + h(d.id) + '">' +
            'Added by mistake — remove this doctor</button></p>'
        : '') +
    '</form>';
  }

  /** Live webcam view — used on laptops, where `capture` is ignored and the
      file input would otherwise open a file browser instead of a camera. */
  function cameraView() {
    return '<div class="camwrap">' +
        '<video id="cam-video" playsinline autoplay muted></video>' +
        '<p class="hint" id="cam-hint">Starting camera…</p>' +
      '</div>' +
      '<div class="btnrow">' +
        '<button type="button" class="btn primary" data-action="cam-shoot">📸 Take photo</button>' +
        '<button type="button" class="btn" data-action="cam-file">🖼 Choose a file</button>' +
        '<button type="button" class="btn" data-close="1">Cancel</button>' +
      '</div>';
  }

  /** Progress panel while the card is being read. */
  function ocrProgress(cardURL) {
    return '<div class="cardshot cardshot-form">' +
        '<img src="' + h(cardURL) + '" alt="Visiting card">' +
      '</div>' +
      '<div class="ocrbar"><div class="ocrbar-fill" id="ocr-fill" style="width:0%"></div></div>' +
      '<p class="busy" id="ocr-status">Reading the card…</p>' +
      '<p class="hint" style="text-align:center">The first scan downloads the reader, so it takes a moment. ' +
      'You can skip the wait and type it in yourself.</p>' +
      '<button class="btn wide" data-action="ocr-skip">Skip — I’ll type it in</button>';
  }

  /** Summary of what the scan managed to read, shown above the filled form. */
  function ocrSummary(found) {
    var got = [];
    if (found.name) got.push('name');
    if (found.mobile) got.push('mobile');
    if (found.hospital) got.push('hospital');
    if (found.area) got.push('area');

    if (!got.length) {
      return '<div class="warnbox">Could not read anything from the card — the photo may be blurred or badly lit. ' +
        'Type it in below — the photo stays on screen.</div>';
    }
    return '<div class="okbox">✅ Filled <b>' + h(got.join(', ')) + '</b> from the card. ' +
      'Please check it — the reader sometimes gets things wrong.</div>';
  }

  /** Shown when a new doctor looks like one already in the list. */
  function duplicateChoice(matches, hasCard) {
    return '<p class="hint" style="margin-top:0">This looks like a doctor already in your list:</p>' +
      matches.map(function (d) {
        var bits = [d.hospital, P.titleCase(d.area), d.mobile].filter(Boolean).map(h).join(' · ');
        return '<div class="card" style="margin-bottom:8px"><div class="card-name">' + title(d.name) + '</div>' +
          (bits ? '<div class="card-meta">' + bits + '</div>' : '') +
          (d.slots.length
            ? '<div class="tags">' + d.slots.map(function (s) {
                return '<span class="tag day">' + h(P.DAY_SHORT[s.day]) +
                  (s.time ? ' ' + h(P.formatTime(s.time)) : '') + '</span>';
              }).join('') + '</div>'
            : '') +
        '</div>';
      }).join('') +
      '<button class="btn primary wide" style="margin-bottom:8px" data-action="dup-use-existing" data-id="' + h(matches[0].id) + '">' +
        (hasCard ? '📎 Add the card to this doctor' : '👉 Open this doctor') + '</button>' +
      '<button class="btn wide" style="margin-bottom:8px" data-action="dup-create">Add as a new doctor anyway</button>' +
      '<button class="btn wide" data-action="dup-back">← Back to the form</button>';
  }

  function visitForm(d) {
    return '<form data-form="visit" data-id="' + h(d.id) + '">' +
      '<div class="field"><label for="v-note">Note (optional)</label>' +
        '<textarea id="v-note" name="note" placeholder="Gave samples, got an order, follow up next month…"></textarea></div>' +
      '<div class="btnrow">' +
        '<button type="submit" class="btn primary">✓ Save visit</button>' +
        '<button type="button" class="btn" data-close="1">Cancel</button>' +
      '</div>' +
    '</form>';
  }

  /* ---------- data screen ---------- */

  function data() {
    var st = S.stats();
    var s = S.settings();
    return '' +
      '<h1 class="page-title">Data</h1>' +
      '<p class="hint" style="margin:-6px 2px 14px">There are three ways to add a doctor — use whichever suits you.</p>' +

      '<section class="section">' +
        '<div class="section-head"><h2>1 · Excel / CSV import</h2></div>' +
        '<div class="card">' +
          '<p class="hint" style="margin-top:0">.xlsx, .xls, .csv — or a .json backup you exported earlier. ' +
          'Columns are detected automatically and you can change them. Fastest way to add a hundred doctors at once.</p>' +
          '<input type="file" id="file-input" accept=".xlsx,.xls,.csv,.json" style="margin-bottom:10px">' +
          '<div id="import-stage"></div>' +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>2 · Manual — type it in</h2></div>' +
        '<div class="card">' +
          '<p class="hint" style="margin-top:0">For adding one or two doctors, or correcting someone\u2019s details.</p>' +
          '<button class="btn primary wide" data-action="add-manual">➕ Add a new doctor</button>' +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>3 · From a visiting card — filled in for you</h2></div>' +
        '<div class="card">' +
          '<p class="hint" style="margin-top:0">Take a photo of the card. The app reads it and fills in the name, mobile, hospital and area ' +
          '<b>for you</b> — a card printed in Hindi or Gujarati still fills the form in English. ' +
          'You just check it and save.</p>' +
          '<div class="btnrow">' +
            '<button class="btn primary" data-action="card-camera">📷 Camera</button>' +
            '<button class="btn" data-action="card-gallery">🖼 Gallery</button>' +
          '</div>' +
          '<p class="hint">The first scan downloads the card reader once. ' +
          'After that it works without internet too.</p>' +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Backup</h2></div>' +
        '<div class="card">' +
          '<p class="hint" style="margin-top:0">Your data lives only in this browser. Always take a backup before changing phones.</p>' +
          '<div class="btnrow">' +
            '<button class="btn primary" data-action="export-json">⬇ JSON backup</button>' +
            '<button class="btn" data-action="export-xlsx">⬇ Excel export</button>' +
          '</div>' +
          '<button class="btn wide" style="margin-top:8px" data-action="export-full">⬇ Full backup (with card photos)</button>' +
          '<p class="hint">The JSON backup is small but holds no photos. The full backup includes them, ' +
          'so the file can be much larger.</p>' +
        '</div>' +
      '</section>' +

      '<section class="section">' +
        '<div class="section-head"><h2>Status</h2></div>' +
        '<div class="card"><dl class="kv">' +
          '<dt>Contacts</dt><dd>' + st.total + '</dd>' +
          '<dt>Day set</dt><dd>' + st.scheduled + '</dd>' +
          '<dt>Day missing</dt><dd>' + st.unscheduled + '</dd>' +
          '<dt>Areas</dt><dd>' + st.areas + '</dd>' +
          '<dt>Visiting cards</dt><dd id="card-usage">checking…</dd>' +
          '<dt>Last import</dt><dd>' + h(s.lastImport ? new Date(s.lastImport).toLocaleString() : '—') + '</dd>' +
          '<dt>Offline</dt><dd id="sw-status">checking…</dd>' +
        '</dl></div>' +
      '</section>';
  }

  function notFound(what) {
    return emptyBox(what + ' not found', 'It may have been deleted, or the link is out of date.',
      '<a class="btn primary" href="#/">Home</a>');
  }

  DD.views = {
    h: h,
    home: home,
    days: days,
    day: day,
    areas: areas,
    area: area,
    doctors: doctors,
    doctor: doctor,
    data: data,
    notFound: notFound,
    doctorCard: doctorCard,
    typeBadge: typeBadge,
    doctorRow: doctorRow,
    doctorTile: doctorTile,
    slotSummary: slotSummary,
    markers: markers,
    doctorForm: doctorForm,
    blankRecord: blankRecord,
    cardEmpty: cardEmpty,
    cardShown: cardShown,
    ocrProgress: ocrProgress,
    ocrSummary: ocrSummary,
    cameraView: cameraView,
    slotRow: slotRow,
    groupSlots: groupSlots,
    daysLabel: daysLabel,
    visitForm: visitForm,
    duplicateChoice: duplicateChoice,
    filterState: filterState,
    emptyBox: emptyBox
  };
})(window.DD = window.DD || {});
