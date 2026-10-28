const express = require("express");

const { createDatabase, initializeDatabase } = require("./database");
const { createApp } = require("./app");

const db = createDatabase();
const portfolioApp = createApp({ db, sessionCleanupInterval: 0 });
const app = express();
let initialization;

app.use((req, res, next) => {
  initialization ??= initializeDatabase(db);
  initialization
    .then(() => portfolioApp(req, res))
    .catch(next);
});

module.exports = app;
