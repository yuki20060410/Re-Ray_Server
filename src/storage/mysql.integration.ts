// MySQL 版に、保存の窓口の約束のテスト(contract.ts)を流す。Docker の MySQL が要るので npm test には入れない
//
// 使い方: npm run docker:up(MySQL が healthy になるまで待つ)→ npm run test:mysql
//
// 開発用の DB(reray)は触らない。root で **reray_test** を毎回作り直し、db/init の 01・03 を流す。
// 1 件ごとに、全部の表を空にして 02(一覧表の最初の中身)を入れ直す。
// 2026-11-06 作成

import { existsSync, readFileSync } from "node:fs";
import { after, before } from "node:test";
import mysql from "mysql2/promise";
import { runStorageContract } from "./contract.js";
import { MysqlStorage } from "./mysql.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const DB = "reray_test";
const sql = (name: string) => readFileSync(new URL(`../../db/init/${name}`, import.meta.url), "utf8");
const TABLES = [
  "events", "admins", "device_events", "message_deliveries", "messages", "signals", "lora_frames",
  "devices", "instruction_codes", "signal_codes", "positions",
];

const base = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3307,
  user: "root",
  password: process.env.DB_ROOT_PASS ?? "",
};

let admin: mysql.Connection;
let storage: MysqlStorage;

before(async () => {
  admin = await mysql.createConnection({ ...base, multipleStatements: true, charset: "utf8mb4" });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}; CREATE DATABASE ${DB} CHARACTER SET utf8mb4; USE ${DB};`);
  await admin.query(sql("01_schema.sql"));
  await admin.query(sql("03_server.sql"));
  storage = MysqlStorage.create({ ...base, database: DB });
});

after(async () => {
  await storage?.close();
  await admin?.end();
});

runStorageContract("MySQL", async () => {
  await admin.query(
    // TRUNCATE は表ごとに作り直すので遅い(1 件 1.6 秒)。DELETE で空にする(id の続きは気にしない)
    `SET FOREIGN_KEY_CHECKS = 0; ${TABLES.map((t) => `DELETE FROM ${t};`).join(" ")} SET FOREIGN_KEY_CHECKS = 1;`,
  );
  await admin.query(sql("02_seed.sql"));
  return storage;
});
