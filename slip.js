/* Parser für Verdienstabrechnungen (SD Worx / Entgeltbescheinigung).
   Läuft komplett lokal im Browser. Speichert nur Beträge und Lohnart-Namen,
   keine Namen, Adressen, IBAN, Steuer-ID oder SV-Nummer. */
(function (root) {
  'use strict';

  // pdf.js-Textelemente einer Seite zu Textzeilen zusammensetzen
  function itemsToLines(items) {
    const rows = [];
    for (const it of items) {
      const s = it.str;
      if (!s || !s.trim()) continue;
      const x = it.transform[4], y = it.transform[5], w = it.width || 0;
      let r = rows.find(r => Math.abs(r.y - y) < 2.5);
      if (!r) { r = { y, parts: [] }; rows.push(r); }
      r.parts.push({ x, w, s });
    }
    rows.sort((a, b) => b.y - a.y);
    return rows.map(r => {
      r.parts.sort((a, b) => a.x - b.x);
      let out = '', end = null;
      for (const p of r.parts) {
        if (end !== null && p.x - end > 1.2) out += ' ';
        out += p.s; end = p.x + p.w;
      }
      return out.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
  }

  const NUM = /-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}/g;
  const toNum = s => Number(s.replace(/\./g, '').replace(',', '.'));
  // Alle Beträge einer Zeile; ein direkt folgendes "-" macht den Betrag negativ
  function nums(line) {
    const out = []; let m; NUM.lastIndex = 0;
    while ((m = NUM.exec(line))) {
      let v = toNum(m[0]);
      if (line[m.index + m[0].length] === '-') v = -v;
      out.push(v);
    }
    return out;
  }
  const last = a => a.length ? a[a.length - 1] : null;
  const r2 = v => Math.round(v * 100) / 100;
  const ym = mmYYYY => { const [m, y] = mmYYYY.split('.'); return y + '-' + m.padStart(2, '0'); };

  function parsePage(lines) {
    const p = { month: null, retroFor: null, brutto: null, items: [], tax: { lfd: 0, sonst: 0 }, taxBase: { lfd: 0, sonst: 0 },
      sv: { kv: 0, rv: 0, av: 0, pv: 0 }, svEinmal: 0, svLfd: null, svBaseLfd: null, lstLfd: null, netto: null, after: [], summeLfd: null, uebertrag: 0, auszahlung: null,
      year: null, info: {} };
    let sec = 'head';
    for (const L of lines) {
      let m;
      if ((m = L.match(/^Entgeltbescheinigung\s+(\d{2}\.\d{4})(?:\s+für Monat\s+(\d{2}\.\d{4}))?/))) {
        p.month = ym(m[1]); if (m[2]) p.retroFor = ym(m[2]); continue;
      }
      if ((m = L.match(/St-Kl\.:\s*(\d)/))) p.info.stkl = m[1];
      if ((m = L.match(/KK:\s*\d+\s+(.+?)\s+(\d+,\d+)%/))) { p.info.kk = m[1]; p.info.kkZusatz = toNum(m[2]); }
      if ((m = L.match(/Tarifschl\.\/Wert\s+1:\s*(\S+)/))) p.info.tarif = m[1];
      if ((m = L.match(/Eintrittsdatum\s+(\d{2})\.(\d{2})\.(\d{4})/))) p.info.entry = m[3] + '-' + m[2];
      if (/^Tg Lohnart/.test(L)) { sec = 'items'; continue; }
      if (/^Jahreswerte/.test(L)) { sec = 'year'; p.year = {}; continue; }
      if (/^Legende|^Bankverbindung/.test(L)) { sec = 'end'; continue; }

      if (sec === 'year') {
        if (/^Gesamtbrutto/.test(L)) p.year.brutto = last(nums(L));
        else if (/^Bezug/.test(L)) { const n = nums(L); p.year.steuerbrutto = n[0]; p.year.lohnsteuer = n[1] || 0; if (n.length > 2) p.year.kist = n[2]; }
        else if (/^SV-Beitrag/.test(L)) { const n = nums(L); p.year.sv = r2(n.reduce((a, b) => a + b, 0)); if (n.length >= 4) p.year.svParts = { kv: n[0], rv: n[1], av: n[2], pv: n[3] }; }
        else if (/^SV-Brutto/.test(L)) { const n = nums(L); if (n.length) p.year.svBrutto = n[0]; }
        continue;
      }
      if (/^Gesamtbrutto/.test(L)) { p.brutto = last(nums(L)); sec = 'calc'; continue; }
      if (sec === 'items') {
        if ((m = L.match(/^(\d{3})\s+(.*)$/))) {
          const rest = m[2]; const n = nums(rest); if (!n.length) continue;
          const cut = rest.search(/\s(?:ST\/SV\s)?(?:EZ\s)?\d\d\s\d(?=\s|$)/);
          let name = (cut > 0 ? rest.slice(0, cut) : rest.replace(NUM, '')).replace(/\s+ST\/SV$/, '').trim();
          const cm = cut > 0 ? rest.slice(cut).match(/(\d\d)\s(\d)(?=\s|$)/) : null;
          // st: 00 steuerfrei, 01 laufend, 02 sonstiger Bezug, 38 bAV frei · sv: 0 frei, 1 laufend, 5 einmalig
          // Menge × Satz erkennen (z. B. 6,00 Tage × 78,58 € oder 1,27 Std. × 36,79 € × 30 %)
          const amt = Math.abs(last(n)), c = n.slice(0, -1).map(Math.abs); let qty = null, rate = null;
          for (let x = 0; x < c.length && qty == null; x++) for (let y = x + 1; y < c.length; y++) if (Math.abs(c[x] * c[y] - amt) < 0.05) { qty = c[x]; rate = c[y]; break; }
          for (let x = 0; x < c.length && qty == null; x++) for (let y = x + 1; y < c.length && qty == null; y++) for (let z = y + 1; z < c.length; z++) if (Math.abs(c[x] * c[y] * c[z] / 100 - amt) < 0.05) { qty = c[x]; rate = c[z]; break; }
          // Basis × Prozent (z. B. Weihnachtsgeld 5605,54 × 60 %, T-ZUG B 3521,50 × 18,5 %)
          let base = null, pct = null;
          if (qty == null) for (let x = 0; x < c.length && base == null; x++) for (let y = 0; y < c.length; y++) if (x !== y && c[y] <= 100 && Math.abs(c[x] * c[y] / 100 - amt) < 0.05) { base = c[x]; pct = c[y]; break; }
          p.items.push({ code: m[1], name, amount: last(n), free: /\bN$/.test(rest), st: cm ? cm[1] : null, sv: cm ? cm[2] : null, qty, rate, base, pct });
        }
        continue;
      }
      if (sec === 'calc') {
        if (/^Laufender Bezug/.test(L)) { const n = nums(L); p.taxBase.lfd = n[0]; p.tax.lfd = Math.abs(last(n)); p.lstLfd = n.length >= 3 ? n[1] : Math.abs(last(n)); }
        else if (/^Sonstiger Bezug/.test(L)) { const n = nums(L); p.taxBase.sonst = n[0]; p.tax.sonst = Math.abs(last(n)); }
        else if (/^SV-Brutto lfd\./.test(L)) { p.svBaseLfd = nums(L); }
        else if (/^SV-Beitrag lfd\./.test(L) || /^SV-Beitrag Einmalb\./.test(L)) {
          const n = nums(L); p.sv.kv += n[0]; p.sv.rv += n[1]; p.sv.av += n[2]; p.sv.pv += n[3];
          if (/Einmalb/.test(L)) p.svEinmal += Math.abs(last(n)); else p.svLfd = { kv: n[0], rv: n[1], av: n[2], pv: n[3] };
        }
        else if (/^Netto\s/.test(L) || L === 'Netto') { p.netto = last(nums(L)); sec = 'after'; }
        continue;
      }
      if (sec === 'after') {
        if (/^Summe lfd\. Monat/.test(L)) p.summeLfd = last(nums(L));
        else if (/^Summe Übertrag/.test(L)) p.uebertrag = last(nums(L));
        else if (/^Auszahlung/.test(L)) p.auszahlung = last(nums(L));
        else if (/^Übertrag/.test(L)) p.summeLfd = p.summeLfd ?? last(nums(L));
        else if ((m = L.match(/^(\d{3})\s+(.*)$/))) {
          const n = nums(m[2]); if (!n.length) continue;
          p.after.push({ code: m[1], name: m[2].replace(NUM, '').replace(/-$/, '').replace(/\s+-?\s*$/, '').trim(), amount: last(n) });
        }
      }
    }
    for (const k in p.sv) p.sv[k] = r2(p.sv[k]);
    return p;
  }

  // Alle Seiten auswerten: Hauptabrechnung + Rückrechnungen
  function parseSlip(pages) {
    const parsed = pages.map(parsePage).filter(p => p.month && p.brutto != null);
    const main = parsed.find(p => !p.retroFor) || parsed[parsed.length - 1];
    if (!main) throw new Error('Keine Verdienstabrechnung erkannt.');
    const retros = parsed.filter(p => p !== main && p.retroFor).map(p => ({ month: p.retroFor, brutto: p.brutto, netto: p.netto,
      tax: r2(p.tax.lfd + p.tax.sonst), sv: r2(p.sv.kv + p.sv.rv + p.sv.av + p.sv.pv), items: p.items }));
    const tax = r2(main.tax.lfd + main.tax.sonst);
    const sv = r2(main.sv.kv + main.sv.rv + main.sv.av + main.sv.pv);
    const special = main.items.filter(i => /WEIHNACHT|URLAUBSGELD|SONDERZ|PRÄMIE|PRAEMIE|BONUS|EINMAL|ERFOLGSBET|JUBIL|13\./i.test(i.name) || (main.taxBase.sonst && i.amount === main.taxBase.sonst));
    return {
      month: main.month, brutto: main.brutto, steuerbrutto: r2(main.taxBase.lfd + main.taxBase.sonst), sonstBezug: main.taxBase.sonst,
      tax, taxLfd: main.tax.lfd, taxSonst: main.tax.sonst, lstLfd: main.lstLfd, sv: main.sv, svTotal: sv, svEinmal: r2(main.svEinmal), svLfd: main.svLfd, svBaseLfd: main.svBaseLfd,
      netto: main.netto, after: main.after, summeLfd: main.summeLfd, uebertrag: main.uebertrag || 0,
      auszahlung: main.auszahlung ?? main.summeLfd ?? main.netto,
      items: main.items, special: special.map(i => ({ name: i.name, amount: i.amount })), retros, year: main.year, info: main.info
    };
  }

  async function parsePdf(pdfjs, buf) {
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const pg = await doc.getPage(i);
      pages.push(itemsToLines((await pg.getTextContent()).items));
      pg.cleanup();
    }
    try { await doc.destroy(); } catch (e) {}
    return parseSlip(pages);
  }

  const api = { itemsToLines, parsePage, parseSlip, parsePdf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Slip = api;
})(this);
