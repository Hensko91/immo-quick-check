/*
 * Immo-Quick-Check – Rechenlogik (Stufe 1)
 *
 * Reine Funktionen ohne DOM-Zugriff. Grundlage ist KONZEPT.md
 * („Kennzahlen und Formeln“, „Scoring-Modell“).
 *
 * Konventionen:
 *  - Prozentwerte werden als Anteil übergeben (5 % = 0.05).
 *  - Geldbeträge in EUR; Miete, Hausgeld und Haltekosten pro Monat,
 *    Rücklage in EUR/m² und Jahr, Markt- und Verkaufspreise in EUR/m².
 *  - Leere Felder sind null/undefined und werden durch Standardwerte
 *    (Annahmen) ersetzt, siehe mitStandardwerten().
 *
 * Läuft im Browser (window.Calc) und in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Calc = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Standardannahmen (KONZEPT.md, „Eingabefelder“)
  // ---------------------------------------------------------------------------

  /**
   * Grunderwerbsteuersätze, Stand 03.10.2026. Quellen und Datum siehe
   * wissen/04_Steuer_und_Recht.md; vor Nutzung am Landesrecht gegenprüfen.
   */
  const GRUNDERWERBSTEUER = {
    'Baden-Württemberg': 0.05,
    'Bayern': 0.035,
    'Berlin': 0.06,
    'Brandenburg': 0.065,
    'Bremen': 0.055,
    'Hamburg': 0.055,
    'Hessen': 0.06,
    'Mecklenburg-Vorpommern': 0.06,
    'Niedersachsen': 0.05,
    'Nordrhein-Westfalen': 0.065,
    'Rheinland-Pfalz': 0.05,
    'Saarland': 0.065,
    'Sachsen': 0.055,
    'Sachsen-Anhalt': 0.05,
    'Schleswig-Holstein': 0.065,
    'Thüringen': 0.05,
  };
  const GRUNDERWERBSTEUER_STAND = '03.10.2026';

  const BUNDESLAND_ALIAS = {
    'bavaria': 'Bayern', 'lower saxony': 'Niedersachsen', 'north rhine-westphalia': 'Nordrhein-Westfalen',
    'saxony': 'Sachsen', 'saxony-anhalt': 'Sachsen-Anhalt', 'thuringia': 'Thüringen', 'thueringen': 'Thüringen',
    'hesse': 'Hessen', 'rhineland-palatinate': 'Rheinland-Pfalz', 'mecklenburg-western pomerania': 'Mecklenburg-Vorpommern',
    'baden-wuerttemberg': 'Baden-Württemberg',
  };

  /** Bundeslandnamen (z. B. aus OpenStreetMap: „Freistaat Sachsen“) auf den Tabellenschlüssel abbilden. */
  function normalisiereBundesland(name) {
    if (typeof name !== 'string') return null;
    const s = name.trim().replace(/^(Freistaat|Land|Freie und Hansestadt|Freie Hansestadt)\s+/i, '').trim();
    const treffer = Object.keys(GRUNDERWERBSTEUER).find((k) => k.toLowerCase() === s.toLowerCase());
    return treffer || BUNDESLAND_ALIAS[s.toLowerCase()] || null;
  }

  const STANDARD = {
    bundesland: 'Sachsen-Anhalt',
    notar: 0.02,
    makler: 0.0357,
    zins: 0.05,
    tilgung: 0.012,
    steuersatz: 0.32, // geändert am 03.10.2026 (vorher 35 %)
    // Vermietung
    objektart: 'ETW',
    anteilNichtUmlagefaehig: 0.35,
    ruecklageQm: { ETW: 8, MFH: 12 },
    leerstand: 0.03,
    gebaeudeanteil: 0.75,
    zielCashflow: 50,
    // Fix & Flip
    sanierungspuffer: 0.2,
    haltedauer: 9,
    haltekosten: 0,
    verkaufskosten: 0.03,
    zielmarge: 0.15,
    verkaeufe5J: 0,
    // Zwangsversteigerung (eigene Setzungen, siehe wissen/03_Standardannahmen.md)
    zv: {
      gerichtGrundbuch: 0.015, // Zuschlagsgebühr + Grundbuch + Zinsen auf das Gebot bis zum Verteilungstermin
      makler: 0,
      renovierungsreserve: 0.1, // Vermietung, Anteil am Gebot
      sanierungspuffer: 0.3, // Fix & Flip
      sicherheitsleistung: 0.1, // Anteil am Verkehrswert
    },
  };

  // Kalibrierung 03.10.2026: strenger als im Konzept (dort 70 / 50)
  const AMPEL_GRUEN = 75;
  const AMPEL_GELB = 55;

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  const leer = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && Number.isNaN(v));
  const zahl = (v) => typeof v === 'number' && Number.isFinite(v);
  const teile = (a, b) => (zahl(a) && zahl(b) && b !== 0 ? a / b : null);
  const klemme = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  /**
   * Deutsche Zahleneingabe in eine Zahl umwandeln.
   * „1.234,56“ → 1234.56, „150.000“ → 150000, „5,5“ → 5.5, „“ → null.
   */
  function parseZahl(text) {
    if (typeof text === 'number') return Number.isFinite(text) ? text : null;
    if (typeof text !== 'string') return null;
    let s = text.trim().replace(/[\s €%]/g, '').replace(/−/g, '-');
    if (s === '' || s === '-') return null;
    if (s.includes(',')) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) {
      s = s.replace(/\./g, ''); // Tausenderpunkte ohne Dezimalteil
    }
    if (!/^-?\d*\.?\d+$|^-?\d+\.$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  const nf = (min, max) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });
  const NF0 = nf(0, 0);
  const NF1 = nf(1, 1);
  const NF2 = nf(2, 2);
  const EUR = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });

  const MINUS = '−';
  const vz = (s) => s.replace(/^-/, MINUS);
  function fmtEuro(v) { return zahl(v) ? vz(EUR.format(Math.round(v) === 0 ? 0 : v)) : '–'; }
  function fmtEuroVz(v) { return zahl(v) ? (v > 0.5 ? '+' : '') + fmtEuro(v) : '–'; }
  function fmtProzent(anteil, stellen = 1) {
    if (!zahl(anteil)) return '–';
    const f = stellen === 0 ? NF0 : stellen === 2 ? NF2 : NF1;
    return vz(f.format(anteil * 100)) + ' %';
  }
  function fmtZahl(v, stellen = 0) {
    if (!zahl(v)) return '–';
    const f = stellen === 0 ? NF0 : stellen === 1 ? NF1 : NF2;
    return vz(f.format(v));
  }

  // ---------------------------------------------------------------------------
  // Steuer und Finanzierung
  // ---------------------------------------------------------------------------

  /** AfA-Satz nach Baujahr (§ 7 Abs. 4 EStG, laut KONZEPT.md). */
  function afaSatz(baujahr) {
    if (!zahl(baujahr)) return null;
    if (baujahr < 1925) return 0.025;
    if (baujahr >= 2023) return 0.03;
    return 0.02;
  }

  function grunderwerbsteuerSatz(bundesland) {
    return Object.prototype.hasOwnProperty.call(GRUNDERWERBSTEUER, bundesland) ? GRUNDERWERBSTEUER[bundesland] : null;
  }

  /**
   * Annuitätendarlehen, Jahr 1, monatliche Raten.
   * Kapitaldienst p. a. = Darlehen × (Sollzins + Anfangstilgung), konstant.
   * Zinsen werden monatlich auf die sinkende Restschuld berechnet.
   */
  function annuitaetJahr1(darlehen, zins, tilgung) {
    const kapitaldienst = darlehen * (zins + tilgung);
    const rate = kapitaldienst / 12;
    let rest = darlehen;
    let zinsen = 0;
    for (let m = 0; m < 12 && rest > 0; m++) {
      const z = (rest * zins) / 12;
      zinsen += z;
      rest -= Math.min(rest, rate - z);
    }
    return { kapitaldienst, zinsen, tilgung: kapitaldienst - zinsen, restschuld: rest };
  }

  // ---------------------------------------------------------------------------
  // Standardwerte einsetzen
  // ---------------------------------------------------------------------------

  /**
   * Füllt leere Felder mit Standardannahmen.
   * Rückgabe: { werte, annahmen } – annahmen ist die Liste der Felder,
   * deren Wert eine Annahme (Standardwert) ist.
   */
  function mitStandardwerten(eingabe, modus) {
    const e = Object.assign({}, eingabe);
    const annahmen = [];
    const setze = (feld, wert) => {
      if (leer(e[feld])) {
        e[feld] = wert;
        annahmen.push(feld);
      }
    };

    setze('bundesland', STANDARD.bundesland);
    if (leer(e.grunderwerbsteuer)) {
      const satz = grunderwerbsteuerSatz(e.bundesland);
      if (satz !== null) setze('grunderwerbsteuer', satz);
    }
    const zv = e.zwangsversteigerung === true;
    e.zwangsversteigerung = zv;
    setze('notar', zv ? STANDARD.zv.gerichtGrundbuch : STANDARD.notar);
    setze('makler', zv ? STANDARD.zv.makler : STANDARD.makler);
    setze('zins', STANDARD.zins);
    setze('tilgung', STANDARD.tilgung);
    setze('steuersatz', STANDARD.steuersatz);
    e.risiko = Object.assign({}, e.risiko);

    if (modus === 'flip') {
      setze('sanierungspuffer', zv ? STANDARD.zv.sanierungspuffer : STANDARD.sanierungspuffer);
      setze('haltedauer', STANDARD.haltedauer);
      setze('haltekosten', STANDARD.haltekosten);
      setze('verkaufskosten', STANDARD.verkaufskosten);
      setze('zielmarge', STANDARD.zielmarge);
      setze('verkaeufe5J', STANDARD.verkaeufe5J);
    } else {
      setze('objektart', STANDARD.objektart);
      if (zahl(e.hausgeld)) setze('nichtUmlagefaehig', e.hausgeld * STANDARD.anteilNichtUmlagefaehig);
      setze('ruecklageQm', STANDARD.ruecklageQm[e.objektart] ?? STANDARD.ruecklageQm.ETW);
      setze('leerstand', STANDARD.leerstand);
      setze('gebaeudeanteil', STANDARD.gebaeudeanteil);
      if (zv) setze('renovierungsreserve', STANDARD.zv.renovierungsreserve);
      else if (leer(e.renovierungsreserve)) e.renovierungsreserve = 0;
      if (leer(e.afaSatz) && zahl(e.baujahr)) setze('afaSatz', afaSatz(e.baujahr));
      setze('zielCashflow', STANDARD.zielCashflow);
    }
    // Ohne Eingabe werden die Kaufnebenkosten aus Eigenkapital bezahlt (wird in der Rechnung bestimmt).
    if (leer(e.eigenkapital)) annahmen.push('eigenkapital');
    return { werte: e, annahmen };
  }

  // ---------------------------------------------------------------------------
  // Validierung
  // ---------------------------------------------------------------------------

  /** Liefert eine Liste von Fehlern { feld, text }; leer = alles in Ordnung. */
  function validiere(eingabe, modus) {
    const fehler = [];
    const { werte: w } = mitStandardwerten(eingabe, modus);
    const f = (feld, text) => fehler.push({ feld, text });

    const pflicht = (feld, name, { min = 0, groesserNull = false } = {}) => {
      const v = eingabe[feld];
      if (leer(v)) return f(feld, `Bitte ${name} eingeben.`);
      if (!zahl(v)) return f(feld, `${name}: bitte eine gültige Zahl eingeben.`);
      if (groesserNull && v <= 0) return f(feld, `${name} muss größer als 0 sein.`);
      if (v < min) f(feld, `${name} darf nicht negativ sein.`);
    };
    const bereich = (feld, name, min, max, einheit = '%', faktor = 100) => {
      const v = w[feld];
      if (leer(v)) return;
      if (!zahl(v)) return f(feld, `${name}: bitte eine gültige Zahl eingeben.`);
      if (v < min || v > max) {
        f(feld, `${name} muss zwischen ${fmtZahl(min * faktor, 0)} und ${fmtZahl(max * faktor, 0)} ${einheit} liegen.`);
      }
    };

    pflicht('kaufpreis', 'den Kaufpreis', { groesserNull: true });
    pflicht('wohnflaeche', 'die Wohnfläche', { groesserNull: true });
    if (!leer(eingabe.baujahr) && (!zahl(eingabe.baujahr) || eingabe.baujahr < 1500 || eingabe.baujahr > 2100 || !Number.isInteger(eingabe.baujahr))) {
      f('baujahr', 'Baujahr: bitte eine Jahreszahl wie 1995 eingeben.');
    }
    if (leer(w.grunderwerbsteuer)) f('grunderwerbsteuer', 'Für dieses Bundesland ist kein Satz hinterlegt. Bitte Bundesland wählen oder Grunderwerbsteuer eintragen.');
    bereich('grunderwerbsteuer', 'Grunderwerbsteuer', 0, 0.2);
    bereich('notar', 'Notar und Grundbuch', 0, 0.2);
    bereich('makler', 'Makler', 0, 0.2);
    bereich('renovierungsreserve', 'Renovierungsreserve', 0, 1);
    if (!leer(eingabe.verkehrswert) && (!zahl(eingabe.verkehrswert) || eingabe.verkehrswert < 0)) f('verkehrswert', 'Verkehrswert darf nicht negativ sein.');
    bereich('zins', 'Sollzins', 0, 0.3);
    bereich('steuersatz', 'Grenzsteuersatz', 0, 1);
    if (!leer(eingabe.eigenkapital)) {
      if (!zahl(eingabe.eigenkapital)) f('eigenkapital', 'Eigenkapital: bitte eine gültige Zahl eingeben.');
      else if (eingabe.eigenkapital < 0) f('eigenkapital', 'Eigenkapital darf nicht negativ sein.');
    }

    if (modus === 'flip') {
      pflicht('sanierung', 'die Sanierungskosten');
      pflicht('verkaufspreis', 'den erwarteten Verkaufspreis', { groesserNull: true });
      bereich('sanierungspuffer', 'Sanierungspuffer', 0, 2);
      if (zahl(w.haltedauer) && (w.haltedauer <= 0 || w.haltedauer > 120)) f('haltedauer', 'Haltedauer muss zwischen 1 und 120 Monaten liegen.');
      if (zahl(w.haltekosten) && w.haltekosten < 0) f('haltekosten', 'Haltekosten dürfen nicht negativ sein.');
      bereich('verkaufskosten', 'Verkaufskosten', 0, 0.5);
      bereich('zielmarge', 'Zielmarge', 0, 0.9);
      if (zahl(w.verkaeufe5J) && (w.verkaeufe5J < 0 || !Number.isInteger(w.verkaeufe5J))) f('verkaeufe5J', 'Anzahl der Verkäufe: bitte eine ganze Zahl ab 0 eingeben.');
    } else {
      pflicht('mieteIst', 'die Nettokaltmiete');
      pflicht('hausgeld', 'das Hausgeld bzw. die Bewirtschaftungskosten');
      bereich('tilgung', 'Anfangstilgung', 0, 0.5);
      bereich('leerstand', 'Leerstandsquote', 0, 1);
      bereich('gebaeudeanteil', 'Gebäudeanteil', 0, 1);
      bereich('afaSatz', 'AfA-Satz', 0, 0.2);
      for (const [feld, name] of [['nichtUmlagefaehig', 'Nicht umlagefähige Kosten'], ['ruecklageQm', 'Zusatzrücklage'], ['marktmieteQm', 'Marktmiete'], ['marktpreisQm', 'Marktpreis']]) {
        if (zahl(w[feld]) && w[feld] < 0) f(feld, `${name} darf nicht negativ sein.`);
      }
      if (leer(w.afaSatz)) f('afaSatz', 'Bitte Baujahr oder AfA-Satz eingeben.');
    }
    return fehler;
  }

  // ---------------------------------------------------------------------------
  // Vermietung
  // ---------------------------------------------------------------------------

  /** Kennzahlen Vermietung. Erwartet vollständige Werte (siehe mitStandardwerten). */
  function kennzahlenVermietung(w) {
    const kaufpreis = w.kaufpreis;
    const kaufnebenkosten = kaufpreis * (w.grunderwerbsteuer + w.notar + w.makler);
    // Renovierungsreserve (Zwangsversteigerung): mitfinanziert, steuerlich nicht angesetzt (konservativ)
    const renovierung = kaufpreis * (w.renovierungsreserve || 0);
    const gesamtinvestition = kaufpreis + kaufnebenkosten + renovierung;
    const eigenkapital = zahl(w.eigenkapital) ? w.eigenkapital : kaufnebenkosten;
    const darlehen = Math.max(0, gesamtinvestition - eigenkapital);
    const eigenkapitalEingesetzt = gesamtinvestition - darlehen;
    const fin = annuitaetJahr1(darlehen, w.zins, w.tilgung);

    const jahresmiete = w.mieteIst * 12;
    const mieteEffektiv = jahresmiete * (1 - w.leerstand);
    const nichtUmlagefaehigJahr = w.nichtUmlagefaehig * 12;
    const ruecklageJahr = w.ruecklageQm * w.wohnflaeche;
    const reinertrag = mieteEffektiv - nichtUmlagefaehigJahr - ruecklageJahr;
    const cashflowVorSteuern = reinertrag - fin.kapitaldienst;

    const afa = (kaufpreis + kaufnebenkosten) * w.gebaeudeanteil * w.afaSatz;
    const steuerlichesErgebnis = mieteEffektiv - nichtUmlagefaehigJahr - fin.zinsen - afa;
    const steuerwirkung = steuerlichesErgebnis * w.steuersatz;
    const cashflowNachSteuern = cashflowVorSteuern - steuerwirkung;

    const kaufpreisQm = teile(kaufpreis, w.wohnflaeche);
    const mieteQm = teile(w.mieteIst, w.wohnflaeche);
    const mieteZuMarkt = zahl(w.marktmieteQm) && w.marktmieteQm > 0 ? teile(mieteQm, w.marktmieteQm) : null;
    const preisZuMarkt = zahl(w.marktpreisQm) && w.marktpreisQm > 0 ? teile(kaufpreisQm, w.marktpreisQm) - 1 : null;

    // Miete, bei der der Cashflow vor Steuern 0 ist.
    const breakEvenMiete = w.leerstand < 1
      ? (nichtUmlagefaehigJahr + ruecklageJahr + fin.kapitaldienst) / (12 * (1 - w.leerstand))
      : null;

    return {
      kaufnebenkosten,
      renovierung,
      gesamtinvestition,
      eigenkapital: eigenkapitalEingesetzt,
      darlehen,
      kapitaldienst: fin.kapitaldienst,
      zinsenJahr1: fin.zinsen,
      tilgungJahr1: fin.tilgung,
      jahresmiete,
      mieteEffektiv,
      nichtUmlagefaehigJahr,
      ruecklageJahr,
      reinertrag,
      cashflowVorSteuern,
      afa,
      steuerlichesErgebnis,
      steuerwirkung,
      cashflowNachSteuern,
      cashflowVorSteuernMonat: cashflowVorSteuern / 12,
      cashflowNachSteuernMonat: cashflowNachSteuern / 12,
      kaufpreisfaktor: teile(kaufpreis, jahresmiete),
      bruttomietrendite: teile(jahresmiete, kaufpreis),
      nettomietrendite: teile(reinertrag, gesamtinvestition),
      dscr: teile(reinertrag, fin.kapitaldienst),
      eigenkapitalrendite: eigenkapitalEingesetzt > 0 ? (cashflowNachSteuern + fin.tilgung) / eigenkapitalEingesetzt : null,
      kaufpreisQm,
      mieteQm,
      mieteZuMarkt,
      preisZuMarkt,
      breakEvenMiete,
      sondertilgungspotenzial: Math.max(0, cashflowNachSteuern),
    };
  }

  // ---------------------------------------------------------------------------
  // Fix & Flip
  // ---------------------------------------------------------------------------

  function flipBasis(w) {
    const kaufpreis = w.kaufpreis;
    const kaufnebenkosten = kaufpreis * (w.grunderwerbsteuer + w.notar + w.makler);
    const sanierungGesamt = w.sanierung * (1 + w.sanierungspuffer);
    const eigenkapital = zahl(w.eigenkapital) ? w.eigenkapital : kaufnebenkosten;
    // Sanierung inkl. Puffer wird mitfinanziert (Festlegung, siehe wissen/01_Rechenregeln.md).
    const finanzierungsbedarf = kaufpreis + kaufnebenkosten + sanierungGesamt;
    const darlehen = Math.max(0, finanzierungsbedarf - eigenkapital);
    const eigenkapitalEingesetzt = finanzierungsbedarf - darlehen;
    const finanzierungskosten = (darlehen * w.zins * w.haltedauer) / 12;
    const haltekostenGesamt = w.haltekosten * w.haltedauer;
    const verkaufserloes = w.verkaufspreis;
    const verkaufskosten = verkaufserloes * w.verkaufskosten;
    const kostenOhneVerkauf = kaufpreis + kaufnebenkosten + sanierungGesamt + finanzierungskosten + haltekostenGesamt;
    const gesamtkosten = kostenOhneVerkauf + verkaufskosten;
    const gewinnVorSteuern = verkaufserloes - gesamtkosten;
    // Verluste führen nicht zu einer Erstattung (konservativ).
    const steuer = Math.max(0, gewinnVorSteuern) * w.steuersatz;
    const gewinnNachSteuern = gewinnVorSteuern - steuer;
    return {
      kaufnebenkosten,
      sanierungGesamt,
      eigenkapital: eigenkapitalEingesetzt,
      darlehen,
      finanzierungskosten,
      haltekostenGesamt,
      verkaufserloes,
      verkaufskosten,
      kostenOhneVerkauf,
      gesamtkosten,
      gewinnVorSteuern,
      steuer,
      gewinnNachSteuern,
    };
  }

  /** Kennzahlen Fix & Flip inkl. Stresstest. */
  function kennzahlenFlip(w) {
    const b = flipBasis(w);
    const stress = flipBasis(Object.assign({}, w, {
      verkaufspreis: w.verkaufspreis * 0.9,
      sanierung: w.sanierung * 1.2,
      haltedauer: w.haltedauer + 3,
    }));
    const erloesBeiNull = w.verkaufskosten < 1 ? b.kostenOhneVerkauf / (1 - w.verkaufskosten) : null;
    return Object.assign(b, {
      marge: teile(b.gewinnVorSteuern, b.verkaufserloes),
      renditeGesamtkosten: teile(b.gewinnVorSteuern, b.gesamtkosten),
      eigenkapitalrenditePa: b.eigenkapital > 0 && w.haltedauer > 0 ? ((b.gewinnNachSteuern / b.eigenkapital) * 12) / w.haltedauer : null,
      erloesBeiGewinnNull: erloesBeiNull,
      preispuffer: zahl(erloesBeiNull) ? teile(b.verkaufserloes - erloesBeiNull, b.verkaufserloes) : null,
      gewinnStress: stress.gewinnVorSteuern,
      stress,
      faustregel70: b.verkaufserloes * 0.7 - b.sanierungGesamt,
      kaufpreisQm: teile(w.kaufpreis, w.wohnflaeche),
      verkaufspreisQm: teile(w.verkaufspreis, w.wohnflaeche),
      gewerblicherHandelHinweis: zahl(w.verkaeufe5J) && w.verkaeufe5J >= 3,
    });
  }

  // ---------------------------------------------------------------------------
  // Scoring
  // ---------------------------------------------------------------------------

  /** Lineare Interpolation zwischen 0-Punkte-Schwelle und Voll-Schwelle. */
  function punkte(wert, nullBei, vollBei, gewicht) {
    if (wert === Infinity) return vollBei > nullBei ? gewicht : 0;
    if (wert === -Infinity) return vollBei > nullBei ? 0 : gewicht;
    if (!zahl(wert)) return 0;
    return klemme((wert - nullBei) / (vollBei - nullBei), 0, 1) * gewicht;
  }

  function ampelFuer(punktzahl) {
    if (punktzahl >= AMPEL_GRUEN) return 'gruen';
    if (punktzahl >= AMPEL_GELB) return 'gelb';
    return 'rot';
  }
  const AMPEL_TEXT = { gruen: 'Grün', gelb: 'Gelb', rot: 'Rot' };
  const AMPEL_EMPFEHLUNG = { gruen: 'vertieft prüfen', gelb: 'nur mit Preisnachlass', rot: 'verwerfen' };

  /**
   * Gesamtscore aus Kriterien und K.-o.-Regeln.
   * K.-o. „Rot“ begrenzt die Punktzahl auf AMPEL_GELB − 1, „begrenzt auf Gelb“ auf AMPEL_GRUEN − 1.
   */
  function gesamtScore(kriterien, ko) {
    const roh = kriterien.reduce((s, k) => s + k.punkte, 0);
    let punktzahl = Math.round(roh);
    if (ko.some((k) => k.stufe === 'rot')) punktzahl = Math.min(punktzahl, AMPEL_GELB - 1);
    else if (ko.some((k) => k.stufe === 'gelb')) punktzahl = Math.min(punktzahl, AMPEL_GRUEN - 1);
    const ampel = ampelFuer(punktzahl);

    // Begründung: zuerst K.-o.-Gründe, dann die Kriterien mit den größten Punktverlusten.
    const teile_ = ko.map((k) => k.text);
    const koKeys = ko.map((k) => k.key);
    const schwach = kriterien
      .filter((k) => k.punkte < k.gewicht * 0.5 && !koKeys.includes(k.key))
      .sort((a, b) => (b.gewicht - b.punkte) - (a.gewicht - a.punkte));
    for (const k of schwach) {
      if (teile_.length >= 2) break;
      if (!teile_.includes(k.kurz)) teile_.push(k.kurz);
    }
    if (teile_.length === 0) {
      const stark = kriterien.slice().sort((a, b) => b.punkte / b.gewicht - a.punkte / a.gewicht).slice(0, 2);
      teile_.push(...stark.map((k) => k.kurz));
    }
    return {
      punktzahl,
      rohpunkte: roh,
      ampel,
      ampelText: AMPEL_TEXT[ampel],
      empfehlung: AMPEL_EMPFEHLUNG[ampel],
      begruendung: `${AMPEL_TEXT[ampel]}: ${teile_.join(', ')}`,
      kriterien,
      ko,
    };
  }

  const ENERGIE_RISIKO = ['F', 'G', 'H'];

  /** Risikoabzüge bei Zwangsversteigerung (eigene Setzung). */
  function zvAbzuege(w) {
    if (!w.zwangsversteigerung) return [];
    const a = [['Zwangsversteigerung ohne Gewährleistung', 3]];
    if (w.risiko && w.risiko.keineBesichtigung) a.push(['keine Innenbesichtigung', 3]);
    return a;
  }

  /** Zusatzkennzahlen Zwangsversteigerung: Gebot zum Verkehrswert, Sicherheitsleistung. */
  function zwangsversteigerung(w) {
    if (!w.zwangsversteigerung) return null;
    const vw = zahl(w.verkehrswert) && w.verkehrswert > 0 ? w.verkehrswert : null;
    return {
      verkehrswert: vw,
      gebotZuVerkehrswert: vw ? w.kaufpreis / vw : null,
      sicherheitsleistung: vw ? vw * STANDARD.zv.sicherheitsleistung : null,
    };
  }

  function scoreVermietung(kz, w) {
    const r = w.risiko || {};
    const cfMonat = kz.cashflowNachSteuernMonat;
    const kriterien = [];
    const k = (key, name, gewicht, p, wertText, kurz, hinweis) =>
      kriterien.push({ key, name, gewicht, punkte: p, wertText, kurz, hinweis: hinweis || null });

    k('cashflow', 'Cashflow nach Steuern', 30, punkte(cfMonat, -100, 100, 30),
      `${fmtEuroVz(cfMonat)}/Monat`, `Cashflow ${fmtEuroVz(cfMonat)}/Monat`);

    const dscr = kz.dscr === null && kz.kapitaldienst === 0 ? Infinity : kz.dscr;
    k('dscr', 'Kapitaldienstdeckung (DSCR)', 15, punkte(dscr, 0.9, 1.3, 15),
      dscr === Infinity ? 'kein Darlehen' : fmtZahl(dscr, 2), `DSCR ${dscr === Infinity ? '–' : fmtZahl(dscr, 2)}`);

    k('nettomietrendite', 'Nettomietrendite', 15, punkte(kz.nettomietrendite, 0.025, 0.055, 15),
      fmtProzent(kz.nettomietrendite), `Nettomietrendite ${fmtProzent(kz.nettomietrendite)}`);

    const kpf = kz.kaufpreisfaktor === null ? Infinity : kz.kaufpreisfaktor;
    k('kaufpreisfaktor', 'Kaufpreisfaktor', 10, punkte(kpf, 28, 16, 10),
      kpf === Infinity ? 'keine Miete' : fmtZahl(kpf, 1), `Faktor ${kpf === Infinity ? '–' : fmtZahl(kpf, 1)}`);

    if (kz.preisZuMarkt === null) {
      k('preisMarkt', 'Kaufpreis je m² vs. Markt', 10, 0, 'Marktpreis fehlt', 'Marktpreis fehlt',
        'Ohne Marktpreis je m² gibt es hier 0 Punkte.');
    } else {
      const p = kz.preisZuMarkt;
      const txt = Math.abs(p) < 0.005 ? 'Preis auf Marktniveau' : `Preis ${fmtProzent(Math.abs(p), 0)} ${p > 0 ? 'über' : 'unter'} Markt`;
      k('preisMarkt', 'Kaufpreis je m² vs. Markt', 10, punkte(p, 0.15, -0.15, 10), `${p > 0 ? '+' : ''}${fmtProzent(p, 0)}`, txt);
    }

    if (kz.mieteZuMarkt === null) {
      k('mieteMarkt', 'Ist-Miete vs. Marktmiete', 10, 0, 'Marktmiete fehlt', 'Marktmiete fehlt',
        'Ohne Marktmiete je m² gibt es hier 0 Punkte.');
    } else {
      // Volle Punkte bis 100 % (auch unter 80 %), 0 Punkte ab 115 %.
      k('mieteMarkt', 'Ist-Miete vs. Marktmiete', 10, punkte(kz.mieteZuMarkt, 1.15, 1.0, 10),
        `${fmtProzent(kz.mieteZuMarkt, 0)} der Marktmiete`, `Miete ${fmtProzent(kz.mieteZuMarkt, 0)} der Marktmiete`);
    }

    const abzuege = [];
    if (w.effizienzklasse && ENERGIE_RISIKO.includes(String(w.effizienzklasse).toUpperCase())) abzuege.push(['Effizienzklasse ' + String(w.effizienzklasse).toUpperCase(), 4]);
    if (r.heizungAlt) abzuege.push(['Heizung älter als 25 Jahre', 3]);
    if (r.unsaniert && zahl(w.baujahr) && w.baujahr < 1978) abzuege.push(['unsanierter Bau vor 1978', 3]);
    if (r.sonderumlage || r.sonderumlageOhneAbschlag) abzuege.push(['Sonderumlage', 5]);
    abzuege.push(...zvAbzuege(w));
    const abzug = abzuege.reduce((s, a) => s + a[1], 0);
    k('risiko', 'Objektrisiko', 10, Math.max(0, 10 - abzug),
      abzuege.length ? abzuege.map((a) => `${a[0]} −${a[1]}`).join(', ') : 'keine Abzüge',
      abzuege.length ? 'Risiko: ' + abzuege.map((a) => a[0]).join(', ') : 'keine Objektrisiken');

    const ko = [];
    if (cfMonat < -150) ko.push({ key: 'cashflow', stufe: 'rot', text: `K.-o.: Cashflow ${fmtEuroVz(cfMonat)}/Monat unter −150 €` });
    if (zahl(kz.dscr) && kz.dscr < 1) ko.push({ key: 'dscr', stufe: 'gelb', text: `K.-o.: DSCR ${fmtZahl(kz.dscr, 2)} unter 1,0` });
    if (r.sonderumlageOhneAbschlag) ko.push({ key: 'risiko', stufe: 'gelb', text: 'K.-o.: beschlossene Sonderumlage ohne Preisabschlag' });

    return gesamtScore(kriterien, ko);
  }

  function scoreFlip(kz, w) {
    const r = w.risiko || {};
    const kriterien = [];
    const k = (key, name, gewicht, p, wertText, kurz, hinweis) =>
      kriterien.push({ key, name, gewicht, punkte: p, wertText, kurz, hinweis: hinweis || null });

    k('marge', 'Marge auf Verkaufspreis', 35, punkte(kz.marge, 0.05, 0.2, 35),
      fmtProzent(kz.marge), `Marge ${fmtProzent(kz.marge)}`);

    const basis = kz.gewinnVorSteuern;
    const stressPunkte = basis > 0 ? punkte(kz.gewinnStress, 0, 0.5 * basis, 20) : 0;
    k('stress', 'Gewinn im Stresstest', 20, stressPunkte, fmtEuro(kz.gewinnStress),
      kz.gewinnStress < 0 ? `Verlust im Stresstest (${fmtEuro(kz.gewinnStress)})` : `Stresstest nur ${fmtEuro(kz.gewinnStress)} Gewinn`);

    let ekr = kz.eigenkapitalrenditePa;
    let ekHinweis = null;
    if (ekr === null) {
      ekr = kz.gewinnNachSteuern > 0 ? Infinity : -Infinity;
      ekHinweis = 'Ohne Eigenkapital ist die Rendite nicht definiert; volle Punkte nur bei Gewinn.';
    }
    k('ekRendite', 'Eigenkapitalrendite p. a.', 15, punkte(ekr, 0.2, 1.0, 15),
      zahl(ekr) ? fmtProzent(ekr) : 'kein Eigenkapital', `EK-Rendite ${zahl(ekr) ? fmtProzent(ekr) : '–'}`, ekHinweis);

    k('preispuffer', 'Preispuffer', 15, punkte(kz.preispuffer, 0.05, 0.15, 15),
      fmtProzent(kz.preispuffer), `Preispuffer ${fmtProzent(kz.preispuffer)}`);

    const abzuege = [];
    if (w.sanierung > 0.3 * w.kaufpreis) abzuege.push(['Sanierung über 30 % des Kaufpreises', 5]);
    if (r.statikFeuchte) abzuege.push(['Statik oder Feuchte ungeklärt', 5]);
    if (zahl(w.baujahr) && w.baujahr < 1950) abzuege.push(['Baujahr vor 1950', 3]);
    if (r.nurSchaetzung) abzuege.push(['nur Schätzung ohne Angebot', 2]);
    abzuege.push(...zvAbzuege(w));
    const abzug = abzuege.reduce((s, a) => s + a[1], 0);
    k('risiko', 'Sanierungsrisiko', 15, Math.max(0, 15 - abzug),
      abzuege.length ? abzuege.map((a) => `${a[0]} −${a[1]}`).join(', ') : 'keine Abzüge',
      abzuege.length ? 'Risiko: ' + abzuege.map((a) => a[0]).join(', ') : 'keine Sanierungsrisiken');

    const ko = [];
    if (!zahl(kz.marge) || kz.marge < 0.08) ko.push({ key: 'marge', stufe: 'rot', text: `K.-o.: Marge ${fmtProzent(kz.marge)} unter 8 %` });
    if (kz.gewinnStress < 0) ko.push({ key: 'stress', stufe: 'gelb', text: `K.-o.: Verlust im Stresstest (${fmtEuro(kz.gewinnStress)})` });

    return gesamtScore(kriterien, ko);
  }

  // ---------------------------------------------------------------------------
  // Maximalgebot (Intervallhalbierung)
  // ---------------------------------------------------------------------------

  /**
   * Größter Kaufpreis, für den bedingung(kaufpreis) noch erfüllt ist.
   * Voraussetzung: bedingung ist bei steigendem Kaufpreis erst wahr, dann falsch.
   * Liefert null, wenn die Bedingung schon bei 0 EUR nicht erfüllt ist.
   */
  function sucheMaximalpreis(bedingung, startpreis, genauigkeit = 1) {
    let lo = 0;
    if (!bedingung(lo)) return null;
    let hi = Math.max(1000, startpreis * 2);
    for (let i = 0; i < 40 && bedingung(hi); i++) { lo = hi; hi *= 2; }
    if (bedingung(hi)) return null; // praktisch unbegrenzt
    for (let i = 0; i < 100 && hi - lo > genauigkeit; i++) {
      const mitte = (lo + hi) / 2;
      if (bedingung(mitte)) lo = mitte;
      else hi = mitte;
    }
    return lo;
  }

  // ---------------------------------------------------------------------------
  // Gesamtauswertung
  // ---------------------------------------------------------------------------

  /** Kennzahlen + Score für einen vollständigen Wertesatz. */
  function auswerten(w, modus) {
    const kz = modus === 'flip' ? kennzahlenFlip(w) : kennzahlenVermietung(w);
    const score = modus === 'flip' ? scoreFlip(kz, w) : scoreVermietung(kz, w);
    return { kz, score };
  }

  /**
   * Hauptfunktion: Eingabe (mit leeren Feldern) → vollständiges Ergebnis.
   * Bei ungültiger Eingabe: { ok: false, fehler }.
   */
  function berechne(eingabe, modus) {
    modus = modus === 'flip' ? 'flip' : 'vermietung';
    const fehler = validiere(eingabe, modus);
    if (fehler.length) return { ok: false, modus, fehler };

    const { werte, annahmen } = mitStandardwerten(eingabe, modus);
    const { kz, score } = auswerten(werte, modus);
    const mitPreis = (kp) => auswerten(Object.assign({}, werte, { kaufpreis: kp }), modus);

    let zielBedingung;
    let zielText;
    if (modus === 'flip') {
      zielBedingung = (kp) => { const m = mitPreis(kp).kz.marge; return zahl(m) && m >= werte.zielmarge; };
      zielText = `Zielmarge ${fmtProzent(werte.zielmarge, 0)}`;
    } else {
      zielBedingung = (kp) => mitPreis(kp).kz.cashflowNachSteuernMonat >= werte.zielCashflow;
      zielText = `Ziel-Cashflow ${fmtEuro(werte.zielCashflow)}/Monat`;
    }
    const gebotZiel = sucheMaximalpreis(zielBedingung, werte.kaufpreis);
    const gebotGruen = sucheMaximalpreis((kp) => mitPreis(kp).score.punktzahl >= AMPEL_GRUEN, werte.kaufpreis);
    const abstand = (g) => (g === null ? null : { eur: g - werte.kaufpreis, anteil: (g - werte.kaufpreis) / werte.kaufpreis });

    const hinweise = [];
    const zv = zwangsversteigerung(werte);
    if (zv) {
      Object.assign(kz, zv);
      if (zahl(zv.gebotZuVerkehrswert) && zv.gebotZuVerkehrswert < 0.5) {
        hinweise.push(`Gebot ${fmtProzent(zv.gebotZuVerkehrswert, 0)} des Verkehrswerts: Im ersten Termin wird der Zuschlag unter 5/10 von Amts wegen versagt (§ 85a ZVG).`);
      } else if (zahl(zv.gebotZuVerkehrswert) && zv.gebotZuVerkehrswert < 0.7) {
        hinweise.push(`Gebot ${fmtProzent(zv.gebotZuVerkehrswert, 0)} des Verkehrswerts: Im ersten Termin kann ein Gläubiger unter 7/10 die Versagung des Zuschlags beantragen (§ 74a ZVG).`);
      }
      hinweise.push(zahl(zv.sicherheitsleistung)
        ? `Sicherheitsleistung beim Bieten: ${fmtEuro(zv.sicherheitsleistung)} (10 % des Verkehrswerts), per Überweisung oder Bankbürgschaft, nicht bar.`
        : 'Sicherheitsleistung beim Bieten: in der Regel 10 % des Verkehrswerts. Verkehrswert laut Gutachten eintragen.');
      hinweise.push('Zwangsversteigerung: keine Gewährleistung, Innenbesichtigung oft nicht möglich. Gutachten, bestehen bleibende Rechte (Abteilung II), Hausgeld und Räumung vor dem Termin prüfen. Das Gebot ist ab Zuschlag bis zum Verteilungstermin mit 4 % p. a. zu verzinsen (in den Nebenkosten enthalten).');
    }
    if (modus === 'flip') {
      if (kz.gewerblicherHandelHinweis) {
        hinweise.push('Achtung: Das wäre mindestens der 4. Verkauf innerhalb von etwa 5 Jahren. Es kann gewerblicher Grundstückshandel vorliegen (zusätzlich Gewerbesteuer). Bitte steuerlich beraten lassen.');
      }
      hinweise.push('Verkauf innerhalb von 10 Jahren nach Erwerb ist steuerpflichtig (Spekulationsfrist).');
      if (annahmen.includes('haltekosten')) hinweise.push('Laufende Haltekosten nicht angegeben, mit 0 € gerechnet.');
    } else {
      if (werte.mieteIst === 0) hinweise.push('Nettokaltmiete 0 €: Bei Leerstand die Marktmiete eintragen.');
      if (werte.leerstand >= 1) hinweise.push('Leerstand 100 %: Es fließt keine Miete, die Break-even-Miete ist nicht erreichbar.');
    }

    return {
      ok: true,
      modus,
      werte,
      annahmen,
      kz,
      score,
      maximalgebot: {
        ziel: gebotZiel,
        zielText,
        zielAbstand: abstand(gebotZiel),
        gruen: gebotGruen,
        gruenAbstand: abstand(gebotGruen),
      },
      hinweise,
      fehler: [],
    };
  }

  // ---------------------------------------------------------------------------
  // Empfehlung: beide Strategien vergleichen
  // ---------------------------------------------------------------------------

  const STRATEGIE_NAME = { vermietung: 'Vermietung', flip: 'Fix & Flip' };

  /**
   * Rechnet dieselbe Eingabe als Vermietung und als Fix & Flip.
   * Empfohlen wird die Strategie mit dem höheren Score; die Ampel dieser
   * Strategie bestimmt die Aktion (Grün: vertieft prüfen, Gelb: verhandeln,
   * Rot: verwerfen). Nicht bewertbare Strategien (fehlende Pflichtfelder)
   * werden übergangen.
   */
  function empfehlung(eingabe) {
    const vermietung = berechne(eingabe, 'vermietung');
    const flip = berechne(eingabe, 'flip');
    const bewertbar = [vermietung, flip].filter((r) => r.ok);
    if (!bewertbar.length) return { ok: false, vermietung, flip };

    bewertbar.sort((a, b) => b.score.punktzahl - a.score.punktzahl);
    const beste = bewertbar[0];
    const name = STRATEGIE_NAME[beste.modus];
    const gleichauf = bewertbar.length === 2 && bewertbar[0].score.punktzahl === bewertbar[1].score.punktzahl;
    const ampel = beste.score.ampel;
    const gebot = beste.maximalgebot;
    const gebotGruen = gebot.gruen !== null ? Math.floor(gebot.gruen / 100) * 100 : null;
    const gebotZiel = gebot.ziel !== null ? Math.floor(gebot.ziel / 100) * 100 : null;

    let aktion, titel, text;
    if (ampel === 'gruen') {
      aktion = 'pruefen';
      titel = `Vertieft prüfen als ${name}`;
      text = `${name} erreicht ${beste.score.punktzahl} Punkte. Nächster Schritt: Deep-Check und Due Diligence.`;
    } else if (ampel === 'gelb') {
      aktion = 'verhandeln';
      titel = `Verhandeln als ${name}`;
      if (gebotGruen !== null && gebotGruen > 0) {
        text = `Nur mit Preisnachlass: Bei höchstens ${fmtEuro(gebotGruen)} wird ${name} grün.`;
      } else if (gebotZiel !== null && gebotZiel > 0) {
        text = `Nur mit Preisnachlass: Obergrenze ${fmtEuro(gebotZiel)} (${gebot.zielText}).`;
      } else {
        text = 'Nur mit Preisnachlass; auch ein niedrigerer Preis erreicht kein Grün. Annahmen prüfen.';
      }
    } else {
      aktion = 'verwerfen';
      titel = 'Verwerfen';
      text = bewertbar.length === 2
        ? `Beide Strategien sind rot (Vermietung ${vermietung.score.punktzahl}, Fix & Flip ${flip.score.punktzahl} Punkte).`
        : `${name} ist rot; die andere Strategie ist mangels Angaben nicht bewertbar.`;
    }
    if (gleichauf && ampel !== 'rot') text += ' Beide Strategien liegen gleichauf.';

    return {
      ok: true,
      empfohlen: beste.modus,
      strategie: name,
      ampel,
      punktzahl: beste.score.punktzahl,
      aktion,
      titel,
      text,
      begruendung: beste.score.begruendung,
      gleichauf,
      vermietung,
      flip,
    };
  }

  return {
    STANDARD,
    STRATEGIE_NAME,
    empfehlung,
    GRUNDERWERBSTEUER,
    GRUNDERWERBSTEUER_STAND,
    normalisiereBundesland,
    AMPEL_GRUEN,
    AMPEL_GELB,
    parseZahl,
    fmtEuro,
    fmtEuroVz,
    fmtProzent,
    fmtZahl,
    afaSatz,
    grunderwerbsteuerSatz,
    annuitaetJahr1,
    mitStandardwerten,
    validiere,
    kennzahlenVermietung,
    kennzahlenFlip,
    punkte,
    scoreVermietung,
    scoreFlip,
    sucheMaximalpreis,
    berechne,
  };
});
