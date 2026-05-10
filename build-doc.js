// One-shot generator for the install instructions Word doc.
// Run with: node build-doc.js
const fs = require('fs');
const {
  Document, Packer, Paragraph, TextRun, ExternalHyperlink,
  HeadingLevel, AlignmentType, LevelFormat, PageOrientation, BorderStyle,
} = require('docx');

const heading = (text, level) => new Paragraph({
  heading: level, children: [new TextRun({ text })],
});

const para = (text, opts = {}) => new Paragraph({
  spacing: { after: opts.afterSpace ?? 120 },
  children: [new TextRun({ text, bold: !!opts.bold })],
});

const bullet = (text) => new Paragraph({
  numbering: { reference: 'bullets', level: 0 },
  children: [new TextRun({ text })],
});

const numbered = (text) => new Paragraph({
  numbering: { reference: 'steps', level: 0 },
  children: [new TextRun({ text })],
});

const link = (label, url) => new Paragraph({
  spacing: { after: 120 },
  children: [
    new TextRun({ text: 'URL: ' }),
    new ExternalHyperlink({
      link: url,
      children: [new TextRun({ text: url, style: 'Hyperlink' })],
    }),
  ],
});

const divider = new Paragraph({
  spacing: { before: 120, after: 120 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'A87514', space: 1 } },
});

const URL = 'https://suki-blip.github.io/kitchen-crm/';

const doc = new Document({
  creator: 'MAKO Cabinets',
  title: 'Installing MAKO Cabinets CRM as an App',
  styles: {
    default: { document: { run: { font: 'Calibri', size: 22 } } },
    paragraphStyles: [
      {
        id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 40, bold: true, color: 'A87514', font: 'Calibri' },
        paragraph: { spacing: { before: 0, after: 240 }, outlineLevel: 0 },
      },
      {
        id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 30, bold: true, color: '1D1B17', font: 'Calibri' },
        paragraph: { spacing: { before: 320, after: 160 }, outlineLevel: 0 },
      },
      {
        id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 26, bold: true, color: 'A87514', font: 'Calibri' },
        paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 1 },
      },
    ],
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [{
        level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }] },
      { reference: 'steps', levels: [{
        level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 720, hanging: 360 } } },
      }] },
    ],
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
      },
    },
    children: [
      // Title block
      new Paragraph({
        style: 'Title', alignment: AlignmentType.LEFT,
        children: [new TextRun({ text: 'Installing MAKO Cabinets CRM as an App' })],
      }),
      new Paragraph({
        spacing: { after: 240 },
        children: [new TextRun({
          text: 'A short guide to install the CRM on your phone, tablet, or computer so it behaves like a regular app.',
          color: '5D5950', italics: true,
        })],
      }),
      link('App URL', URL),
      divider,

      // Android
      heading('Android (Chrome / Edge)', HeadingLevel.HEADING_1),
      numbered('Open ' + URL + ' in Chrome or Edge.'),
      numbered('After a few seconds, the browser will offer to install the app — either as a banner at the bottom or as a "Install MAKO Cabinets CRM" item under the menu (⋮).'),
      numbered('Tap Install.'),
      numbered('The icon appears on your home screen like a regular app. Tap it to open.'),

      // iOS
      heading('iPhone and iPad (Safari only)', HeadingLevel.HEADING_1),
      para('Important: this only works in Safari. Chrome on iPhone does not support installing PWAs.', { bold: true }),
      numbered('Open ' + URL + ' in Safari.'),
      numbered('Tap the Share button (the square with an arrow pointing up) at the bottom of the screen.'),
      numbered('Scroll down and tap "Add to Home Screen".'),
      numbered('Tap Add. The icon appears on your home screen.'),

      // Desktop
      heading('Desktop (Chrome / Edge)', HeadingLevel.HEADING_1),
      numbered('Open ' + URL + ' in Chrome or Edge.'),
      numbered('At the right edge of the address bar an install icon appears (a small monitor with an arrow).'),
      numbered('Click it, then click Install.'),
      numbered('The app opens in its own window without the browser tabs and address bar.'),

      divider,

      // What you get
      heading('What you get after installing', HeadingLevel.HEADING_1),
      bullet('A gold-and-cream MAKO icon on your home screen or app drawer.'),
      bullet('Full-screen experience — no browser bar, looks and feels like a native app.'),
      bullet('Cream splash screen while the app loads.'),
      bullet('Offline launch of the app shell — if your network is slow the screen loads instantly. Only the live data (customers, projects, tasks) waits for the network.'),
      bullet('Automatic updates — the next time you open the app after a code change, it refreshes itself in the background.'),

      // Limitations
      heading('Current limitations', HeadingLevel.HEADING_1),
      bullet('No push notifications. The internal chat works only while the app is open and you have an internet connection.'),
      bullet('No App Store / Google Play presence yet. The app is installed straight from the website.'),
      bullet('Data is stored in the cloud (Supabase). You need an internet connection to read or write changes.'),

      divider,

      // Need help
      heading('Need help?', HeadingLevel.HEADING_1),
      para('If the install option does not appear:', { afterSpace: 80 }),
      bullet('Make sure you are on the official URL (Chrome / Edge / Safari only — not in-app browsers like Facebook or Instagram).'),
      bullet('Refresh the page once and wait 5–10 seconds before checking the menu.'),
      bullet('On iPhone, double-check that you are using Safari and not Chrome.'),
    ],
  }],
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync('Installing-MAKO-CRM-App.docx', buf);
  console.log('Created Installing-MAKO-CRM-App.docx (' + buf.length + ' bytes)');
});
