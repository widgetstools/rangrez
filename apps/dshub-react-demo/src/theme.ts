import { themeQuartz, colorSchemeDark, iconSetQuartzBold } from 'ag-grid-community';

// A dark, monospace blotter theme via the AG-Grid v36 Theming API (no CSS import).
export const blotterTheme = themeQuartz
  .withPart(colorSchemeDark)
  .withPart(iconSetQuartzBold)
  .withParams({
    backgroundColor: '#0e1216',
    foregroundColor: '#e7eaed',
    borderColor: '#2b3138',
    headerBackgroundColor: '#14181d',
    headerTextColor: '#8a939c',
    oddRowBackgroundColor: '#12161b',
    rowHoverColor: '#1a1f26',
    accentColor: '#e5a244',
    fontFamily: 'ui-monospace, Menlo, monospace',
    fontSize: 12,
    headerFontSize: 11,
    rowHeight: 26,
    headerHeight: 30,
  });
