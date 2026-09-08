import { themeQuartz, colorSchemeDark, iconSetQuartzBold } from 'ag-grid-community';

export const blotterTheme = themeQuartz
  .withPart(colorSchemeDark)
  .withPart(iconSetQuartzBold)
  .withParams({
    backgroundColor: '#14181d',
    foregroundColor: '#e7eaed',
    borderColor: '#2b3138',
    headerBackgroundColor: '#1a1e23',
    headerTextColor: '#8a939c',
    oddRowBackgroundColor: '#171b21',
    rowHoverColor: '#1e242b',
    accentColor: '#e5a244',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 12,
    headerFontSize: 11,
    rowHeight: 26,
    headerHeight: 30,
    cellHorizontalPadding: 8,
  });
