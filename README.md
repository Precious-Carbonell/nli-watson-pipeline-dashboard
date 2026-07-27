# Contradictory, My Dear Watson - EDA Dashboard & Pipeline

## Links

* Live Dashboard: https://nli-watson-pipeline-dashboard.vercel.app
* Competition Link: https://www.kaggle.com/competitions/contradictory-my-dear-watson
* Dataset: https://www.tensorflow.org/datasets

---

## 📌 Problem Summary

The task is a **Natural Language Inference (NLI)** problem, where the goal is to determine the relationship between two sentences:

* **Premise**
* **Hypothesis**

Each pair is classified into:

* **0 → Entailment** (hypothesis is true given the premise)
* **1 → Neutral** (relationship is uncertain)
* **2 → Contradiction** (hypothesis conflicts with the premise)

The dataset is **multilingual**, covering 15 languages, making the task more challenging due to cross-lingual semantics.

---

## 🎯 Project Objectives

* Perform structured EDA on multilingual sentence pairs
* Identify label and language distributions
* Analyze text characteristics (length, tokens, patterns)
* Surface insights that inform model selection and feature engineering

---

## 🏗️ Architecture

### 🔹 Data Pipeline (`/pipeline`)

* **Node.js**
* **DuckDB (in-process SQL engine)**

**Workflow:**

1. Load raw CSV data
2. Clean, validate, and deduplicate using SQL
3. Export optimized **Parquet files (Snappy compression)**
4. Run validation queries after each step

---

### 🔹 Dashboard (`/dashboard`)

* **React + TypeScript (Vite)**
* **DuckDB-WASM (in-browser SQL engine)**
* **Recharts for visualization**

💡 All queries run directly in the browser — no backend required.

---

## 📊 Dashboard Features

* 📌 Label distribution (entailment / neutral / contradiction)
* 🌍 Language distribution across 15 languages
* 📏 Sentence length analysis (premise vs hypothesis)
* 🔍 Token and word frequency insights
* 🔗 Relationship patterns between sentence pairs

---

## ⚡ Data Design

* Format: **Parquet**
* Compression: **Snappy**
* Shared schema between pipeline and dashboard
* Ensures fast, columnar querying in-browser

---

## 🚀 Tech Stack

**Pipeline**

* Node.js
* DuckDB

**Dashboard**

* React + TypeScript
* Vite
* DuckDB-WASM
* Recharts


