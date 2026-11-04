// Shared handle so modules can call back into the app without import cycles.
// app.js fills in the methods at start-up.
export const app = {};
