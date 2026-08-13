try {
  await (window.AuroraNativeReady || Promise.resolve());
} catch (error) {
  console.warn("[AuroraNative] bootstrap_warning", {
    error: error instanceof Error ? error.message : String(error),
  });
}

await import("./assets/index-CyRXoI_r.js");
