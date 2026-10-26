// Runs before any test file imports src/, whose language is fixed when src/i18n.ts loads.
process.env.OMOMP_LANG ??= "zh";
