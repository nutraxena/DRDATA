/* Dr-Diary — Devanagari / Gujarati -> Latin transliteration.
   A visiting card printed in Hindi or Gujarati should still fill the form in
   English letters. This is not a full linguistic transliterator; it targets
   names, clinics and areas, which is what the form needs. */
(function (DD) {
  'use strict';

  /* Gujarati sits exactly 0x180 above Devanagari in Unicode (क U+0915 /
     ક U+0A95), so one table serves both once Gujarati is shifted down. */
  var GUJ_OFFSET = 0x180;

  function gujaratiToDevanagari(s) {
    return String(s).replace(/[઀-૿]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - GUJ_OFFSET);
    });
  }

  // Consonants carry an inherent 'a' unless a matra or virama follows.
  var CONS = {
    'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
    'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
    'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
    'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
    'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
    'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'ळ': 'l',
    'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
    // precomposed nukta forms
    'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y'
  };

  var VOWELS = {
    'अ': 'a', 'आ': 'a', 'इ': 'i', 'ई': 'i', 'उ': 'u', 'ऊ': 'u',
    'ऋ': 'ri', 'ॠ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
    'ऑ': 'o', 'ऍ': 'e', 'ॲ': 'a'
  };

  var MATRA = {
    'ा': 'a',  // ा
    'ि': 'i',  // ि
    'ी': 'i',  // ी
    'ु': 'u',  // ु
    'ू': 'u',  // ू
    'ृ': 'ri', // ृ
    'े': 'e',  // े
    'ै': 'ai', // ै
    'ो': 'o',  // ो
    'ौ': 'au', // ौ
    'ॉ': 'o',  // ॉ
    'ॅ': 'e',  // ॅ
    'ॆ': 'e',  // ॆ
    'ॊ': 'o'   // ॊ
  };

  var VIRAMA = '्';
  var NUKTA = '़';
  var ANUSVARA = 'ं';
  var CHANDRABINDU = 'ँ';
  var VISARGA = 'ः';

  var DIGITS = '०';  // ० .. ९

  /**
   * @param word a single whitespace-free token, already normalised to Devanagari
   * @returns Latin text with the final inherent 'a' dropped, so विकास reads
   *          "vikas" rather than "vikasa" and पटेल reads "patel".
   */
  function translitWord(word) {
    // inherent = carries a droppable schwa; hasVowel = an explicit vowel sound
    var units = [];
    var i = 0;

    while (i < word.length) {
      var ch = word[i];

      // Devanagari digits -> ASCII
      if (ch >= DIGITS && ch <= '९') {
        units.push({ text: String(ch.charCodeAt(0) - 0x0966), inherent: false, hasVowel: false });
        i++;
        continue;
      }

      if (VOWELS[ch]) {
        units.push({ text: VOWELS[ch], inherent: false, hasVowel: true });
        i++;
        continue;
      }

      var cons = CONS[ch];
      if (!cons) {
        // Anything else (Latin, punctuation, unknown marks) passes through.
        if (ch === ANUSVARA || ch === CHANDRABINDU) units.push({ text: 'n', inherent: false, hasVowel: false });
        else if (ch === VISARGA) units.push({ text: 'h', inherent: false, hasVowel: false });
        else if (ch !== NUKTA && ch !== VIRAMA) units.push({ text: ch, inherent: false, hasVowel: false });
        i++;
        continue;
      }

      i++;
      if (word[i] === NUKTA) {
        var combined = CONS[ch + NUKTA];
        if (combined) cons = combined;
        i++;
      }

      var next = word[i];
      if (next === VIRAMA) {
        units.push({ text: cons, inherent: false, hasVowel: false });
        i++;
      } else if (MATRA[next]) {
        units.push({ text: cons + MATRA[next], inherent: false, hasVowel: true });
        i++;
      } else {
        units.push({ text: cons + 'a', inherent: true, hasVowel: true });
      }

      // A nasal right after the syllable
      if (word[i] === ANUSVARA || word[i] === CHANDRABINDU) {
        units.push({ text: 'n', inherent: false, hasVowel: false });
        i++;
      }
    }

    // Schwa deletion. Hindi and Gujarati drop the inherent vowel in two places:
    //   1. word-finally      — विकास  vikasa -> vikas
    //   2. before a syllable that has its own vowel, except word-initially
    //                        — मेहता  mehata -> mehta,  मणिनगर stays maninagar
    // The word-initial exemption is what keeps पटेल as "patel", not "ptel".
    var speaks = function (u) { return u && /[a-z0-9]/i.test(u.text); };
    var drop = [];
    for (var k = 0; k < units.length; k++) {
      if (!units[k].inherent) continue;

      // Trailing punctuation must not hide the fact that this is the last sound,
      // otherwise "क्लिनिक," transliterates as "klinika".
      var isLast = true;
      for (var j = k + 1; j < units.length; j++) {
        if (speaks(units[j])) { isLast = false; break; }
      }
      if (isLast) { if (units.length > 1) drop.push(k); continue; }

      // Only an *explicit* vowel on the next syllable triggers the medial drop.
      // Treating an inherent 'a' as a trigger would turn मणिनगर into "maningr".
      var next = units[k + 1];
      if (k > 0 && next && next.hasVowel && !next.inherent) drop.push(k);
    }
    drop.forEach(function (k) { units[k].text = units[k].text.slice(0, -1); });

    return units.map(function (u) { return u.text; }).join('');
  }

  /* Words that turn up on nearly every medical card. Transliteration gives a
     phonetic spelling ("klinik", "hospital"); this maps them to how they are
     actually written in English so the form does not need hand-fixing. */
  var WORD_FIXES = {
    klinik: 'Clinic', kalinik: 'Clinic', hospital: 'Hospital', haspital: 'Hospital',
    orthopedik: 'Orthopaedic', orthopedic: 'Orthopaedic', arthopedik: 'Orthopaedic',
    surjan: 'Surgeon', sarjan: 'Surgeon', doktar: 'Dr', daktar: 'Dr',
    haddi: 'Bone', nursing: 'Nursing', hom: 'Home', sentar: 'Centre', senter: 'Centre',
    medikal: 'Medical', ashram: 'Ashram', nagar: 'Nagar', roda: 'Road', rod: 'Road',
    marg: 'Marg', sosayati: 'Society', society: 'Society', amadavad: 'Ahmedabad',
    ahamadabad: 'Ahmedabad', amdavad: 'Ahmedabad', ahmadabad: 'Ahmedabad',
    ahamdabad: 'Ahmedabad', ahmdabad: 'Ahmedabad'
  };

  function fixWords(latin) {
    return String(latin || '').split(/(\s+)/).map(function (tok) {
      var key = tok.toLowerCase().replace(/[^a-z]/g, '');
      return WORD_FIXES[key] ? tok.replace(/[A-Za-z]+/, WORD_FIXES[key]) : tok;
    }).join('');
  }

  function hasIndic(s) {
    return /[ऀ-ॿ઀-૿]/.test(String(s || ''));
  }

  /** Transliterate a whole string, leaving Latin words untouched. */
  function toLatin(text) {
    if (!hasIndic(text)) return String(text || '');
    var dev = gujaratiToDevanagari(text);
    return dev.split(/(\s+)/).map(function (tok) {
      if (!/\S/.test(tok)) return tok;
      if (!/[ऀ-ॿ]/.test(tok)) return tok;
      return translitWord(tok);
    }).join('');
  }

  /** "डॉ" / "ડૉ" and their spellings all mean Doctor. */
  var DOCTOR_WORDS = /^(d[oa]?[kc]?t?[oa]?r?|dr|do|daktar|daaktar)\.?$/i;

  /** Tidy a transliterated name into the form the rest of the app expects. */
  function cleanName(text) {
    var latin = toLatin(text)
      .replace(/[^A-Za-z .'-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!latin) return '';

    var words = latin.split(' ').filter(Boolean);
    if (words.length && DOCTOR_WORDS.test(words[0])) words.shift();
    if (!words.length) return '';

    return 'DR ' + words.map(function (w) { return w.toUpperCase(); }).join(' ');
  }

  /** Transliterate then normalise common card vocabulary to English spellings. */
  function toEnglish(text) {
    return fixWords(toLatin(text));
  }

  DD.translit = {
    toLatin: toLatin,
    toEnglish: toEnglish,
    fixWords: fixWords,
    hasIndic: hasIndic,
    cleanName: cleanName,
    gujaratiToDevanagari: gujaratiToDevanagari,
    _word: translitWord
  };
})(window.DD = window.DD || {});
