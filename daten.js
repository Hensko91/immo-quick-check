/*
 * Immo-Quick-Check – Datenlogik
 *
 * Reine Funktionen ohne DOM und ohne Netzwerk:
 *  - Datenbestand (Objekte, Marktdaten, Löschvermerke) normalisieren
 *  - zwei Datenbestände zusammenführen (gemeinsame Objektliste über GitHub)
 *  - passende Marktdaten zu einer Lage finden
 *  - Ergebniszeile einer Claude-Recherche auslesen
 *  - Marktdaten als Markdown für 06_Marktdaten_Region.md ausgeben
 *
 * Läuft im Browser (window.Daten, benötigt window.Calc) und in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./calc.js'));
  else root.Daten = factory(root.Calc);
})(typeof self !== 'undefined' ? self : this, function (Calc) {
  'use strict';

  const VERSION = 1;

  /** Leerer Datenbestand. */
  const leererBestand = () => ({ version: VERSION, objekte: [], marktdaten: [], geloescht: [] });

  /**
   * Akzeptiert das alte Format (reine Objektliste als Array) und das neue
   * ({ objekte, marktdaten, geloescht }); verwirft ungültige Einträge.
   */
  function normalisiereBestand(x) {
    const b = leererBestand();
    if (Array.isArray(x)) x = { objekte: x };
    if (!x || typeof x !== 'object') return b;
    const istObj = (o) => o && typeof o === 'object' && typeof o.id === 'string' && o.id;
    b.objekte = (Array.isArray(x.objekte) ? x.objekte : []).filter((o) => istObj(o) && o.felder && typeof o.felder === 'object');
    b.marktdaten = (Array.isArray(x.marktdaten) ? x.marktdaten : []).filter((m) => istObj(m) && typeof m.ort === 'string');
    b.geloescht = (Array.isArray(x.geloescht) ? x.geloescht : []).filter((g) => istObj(g) && typeof g.zeit === 'string');
    return b;
  }

  const zeitObjekt = (o) => String(o.gespeichert || '');
  const zeitMarkt = (m) => String(m.geaendert || '');

  /**
   * Zwei Datenbestände zusammenführen:
   *  - gleiche ID: der zuletzt gespeicherte Stand gewinnt
   *  - Löschvermerk gewinnt, wenn er nicht älter ist als der Eintrag
   *  - alles andere wird vereinigt (nichts geht verloren)
   */
  function fuehreZusammen(a, b) {
    a = normalisiereBestand(a);
    b = normalisiereBestand(b);
    const tote = new Map();
    for (const g of a.geloescht.concat(b.geloescht)) {
      if (!tote.has(g.id) || tote.get(g.id).zeit < g.zeit) tote.set(g.id, g);
    }
    const vereinige = (la, lb, zeit) => {
      const m = new Map();
      for (const e of la.concat(lb)) {
        const alt = m.get(e.id);
        if (!alt || zeit(e) > zeit(alt)) m.set(e.id, e);
      }
      return [...m.values()].filter((e) => !(tote.has(e.id) && tote.get(e.id).zeit >= zeit(e)));
    };
    const objekte = vereinige(a.objekte, b.objekte, zeitObjekt).sort((x, y) => zeitObjekt(y).localeCompare(zeitObjekt(x)));
    const marktdaten = vereinige(a.marktdaten, b.marktdaten, zeitMarkt)
      .sort((x, y) => (x.ort || '').localeCompare(y.ort || '', 'de') || (x.stadtteil || '').localeCompare(y.stadtteil || '', 'de'));
    return { version: VERSION, objekte, marktdaten, geloescht: [...tote.values()] };
  }

  /** Gleicher Inhalt (Reihenfolge der Schlüssel egal)? Für „nichts zu speichern“. */
  function gleicherBestand(a, b) {
    const kanon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
      ? Object.keys(v).sort().reduce((o, key) => { o[key] = v[key]; return o; }, {}) : v));
    return kanon(fuehreZusammen(a, leererBestand())) === kanon(fuehreZusammen(b, leererBestand()));
  }

  // ---------------------------------------------------------------------------
  // Marktdaten
  // ---------------------------------------------------------------------------

  /** Für Vergleiche: Kleinschreibung, ohne Klammern, Satzzeichen und doppelte Leerzeichen. */
  function normText(s) {
    return String(s || '').toLowerCase().replace(/[(),;/]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Passenden Marktdaten-Eintrag zu einer Lage finden.
   * lage: { stadt, stadtteil, text } – text ist die frei eingegebene Adresse.
   * Vorrang: gleicher Ort und gleicher Stadtteil, dann Eintrag für den ganzen Ort;
   * Einträge für einen anderen Stadtteil werden nicht verwendet. Bei mehreren
   * Treffern gewinnt der neueste Stand.
   */
  function findeMarktdaten(tabelle, lage) {
    if (!Array.isArray(tabelle) || !lage) return null;
    const stadt = normText(lage.stadt);
    const teil = normText(lage.stadtteil);
    const text = normText(lage.text);
    let bester = null;
    let besterRang = -1;
    for (const e of tabelle) {
      const ort = normText(e.ort);
      if (ort.length < 2) continue;
      const ortPasst = (stadt && ort === stadt) || (text && (` ${text} `).includes(` ${ort} `));
      if (!ortPasst) continue;
      const eTeil = normText(e.stadtteil);
      let rang;
      if (!eTeil) rang = 1;
      else if ((teil && eTeil === teil) || (text && (` ${text} `).includes(` ${eTeil} `))) rang = 2;
      else continue;
      const neuer = bester && String(e.datum || '') > String(bester.datum || '');
      if (rang > besterRang || (rang === besterRang && neuer)) {
        bester = e;
        besterRang = rang;
      }
    }
    return bester;
  }

  /**
   * Ergebniszeile aus einer Claude-Recherche auslesen, z. B.:
   * MARKTDATEN; Ort=Halle (Saale); Stadtteil=Paulusviertel; Miete=7,80; Kaufpreis=2.150; Quelle=Mietspiegel Halle 2025; Stand=2026-10
   */
  function leseClaudeMarktdaten(text) {
    const zeile = String(text || '').split(/\r?\n/).map((z) => z.trim().replace(/^[`*>\s-]+|[`*\s]+$/g, ''))
      .find((z) => /^MARKTDATEN\b/i.test(z));
    if (!zeile) return { ok: false, fehler: 'Keine Zeile „MARKTDATEN; …“ gefunden. Bitte die letzte Zeile der Claude-Antwort einfügen.' };
    const werte = {};
    for (const teil of zeile.split(';').slice(1)) {
      const i = teil.indexOf('=');
      if (i < 0) continue;
      werte[teil.slice(0, i).trim().toLowerCase()] = teil.slice(i + 1).trim();
    }
    const zahlOderNull = (v) => {
      if (!v || /^(–|-|keine|unbekannt|n\/?a)$/i.test(v)) return null;
      const n = Calc.parseZahl(v.replace(/€.*$/, ''));
      return n !== null && n > 0 ? n : null;
    };
    const eintrag = {
      ort: werte.ort || '',
      stadtteil: werte.stadtteil && !/^(–|-|keine?r?)$/i.test(werte.stadtteil) ? werte.stadtteil : '',
      mieteQm: zahlOderNull(werte.miete),
      kaufpreisQm: zahlOderNull(werte.kaufpreis),
      quelle: werte.quelle || '',
      datum: werte.stand || '',
    };
    if (!eintrag.ort) return { ok: false, fehler: 'In der Zeile fehlt „Ort=…“.' };
    if (eintrag.mieteQm === null && eintrag.kaufpreisQm === null) return { ok: false, fehler: 'In der Zeile fehlen Miete und Kaufpreis.' };
    if (!eintrag.quelle) return { ok: false, fehler: 'In der Zeile fehlt „Quelle=…“. Marktdaten nur mit Quelle übernehmen.' };
    return { ok: true, eintrag };
  }

  /** Marktdaten-Tabelle als Markdown (Wissensdatei 06_Marktdaten_Region.md). */
  function marktdatenMarkdown(tabelle, stand) {
    const zelle = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
    const zahl = (v, s) => (typeof v === 'number' ? Calc.fmtZahl(v, s) : '–');
    const zeilen = (tabelle || []).map((m) =>
      `| ${zelle(m.ort)} | ${zelle(m.stadtteil || '–')} | ${zahl(m.mieteQm, 2)} | ${zahl(m.kaufpreisQm, 0)} | ${zelle(m.quelle)} | ${zelle(m.datum)} | ${zelle(m.notiz || '')} |`);
    return [
      '# 06 Marktdaten Region',
      '',
      `Stand des Exports: ${stand}. Selbst recherchierte Vergleichswerte aus dem Immo-Quick-Check.`,
      'Angebotsmieten und -preise aus Portalen sind keine Abschlusswerte; Quelle und Datum immer mit angeben.',
      '',
      '| Ort | Stadtteil | Marktmiete €/m² | Kaufpreis €/m² | Quelle | Stand | Notiz |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...zeilen,
      '',
    ].join('\n');
  }

  return {
    VERSION,
    leererBestand,
    normalisiereBestand,
    fuehreZusammen,
    gleicherBestand,
    normText,
    findeMarktdaten,
    leseClaudeMarktdaten,
    marktdatenMarkdown,
  };
});
