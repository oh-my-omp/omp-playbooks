// Keep the suite's default process language Chinese; individual tests may override the environment
// to verify that language() and withLanguage() resolve it at call time.
process.env.OMOMP_LANG ??= "zh";
