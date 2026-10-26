// Runs before any test file imports src/, whose language is fixed when src/i18n.ts loads.
process.env.OMP_PLAYBOOKS_LANG ??= "zh";
