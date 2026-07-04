# VEIL

> 対話AIの境界・同意・年齢・危険信号をfail-closedで判定するポリシー層

## 概要
入力・出力・ツール実行前に、適用ポリシーとコンテキストから許可、修正、確認要求、拒否、エスカレーションを返すOSSポリシーエンジン。

## このパッケージの位置付け
本ZIPは、`veil` を単独OSSリポジトリとして着手するための**要求定義・設計・検証・実装バックログ**一式です。
商用利用・セルフホスト・クラウド提供を阻害しないことを前提に、ライセンスはApache-2.0を採用します。

## 想定利用者
AIアプリの安全設計者、プロダクトマネージャー、コンプライアンス、モデレーション、プラットフォーム運用者。

## 解決する範囲
- `Policy Decision Point for Conversational AI`
- マルチテナント、監査、Plugin拡張、外部LLM／ローカルLLMとの疎結合を前提にする
- AI恋愛・コンパニオン用途に限らず、ゲーム、教育、顧客接点、業務AIへ転用可能とする

## 非対象
- 本人の年齢や本人性を単独で証明しない。
- 法的助言・法令適合の保証をしない。
- 安全基準を暗黙に緩和しない。

## ドキュメント索引
| ファイル | 内容 |
|---|---|
| `AGENTS.md` | 実装担当AI・人間開発者向けの不変ルール |
| `docs/00_GLOSSARY.md` | 用語・境界定義 |
| `docs/01_BMA.md` | 事業・ミッション分析（15288） |
| `docs/02_StRS.md` | ステークホルダー要求（29148） |
| `docs/03_SyRS.md` | システム要求（29148 / 25010） |
| `docs/04_AD.md` | アーキテクチャ記述（42010） |
| `docs/05_DD.md` | 設計記述（12207） |
| `docs/06_API_CONTRACT.md` | HTTP API・イベント・Plugin契約 |
| `docs/07_VV_PLAN.md` | 検証・妥当性確認計画 |
| `docs/08_TRACEABILITY.md` | 要求→設計→テストのトレース |
| `docs/09_MVP_BACKLOG.md` | GitHub Issue化可能なMVPバックログ |
| `docs/10_RELEASE_CRITERIA.md` | v0.1.0公開判定基準 |

## 推奨初期技術基盤
- TypeScript（strict） / Node.js LTS / pnpm
- Fastify または同等の高速HTTPフレームワーク
- PostgreSQL（`veil`の主要状態を永続化）
- OpenAPI 3.1、JSON Schema、Docker Compose
- Vitest、Testcontainers、ESLint、Prettier、GitHub Actions
- 監査・運用メトリクスはOpenTelemetry互換のtrace IDを前提とする

## 初期リポジトリ構造
```text
veil/
├── apps/api/             # HTTP API
├── packages/core/        # ドメイン・ユースケース
├── packages/contracts/   # JSON Schema / OpenAPI / DTO
├── packages/plugins/     # Plugin SPIと標準実装
├── packages/sdk-ts/      # TypeScript SDK
├── tests/                # unit / integration / contract / e2e
├── docs/                 # 本パッケージのドキュメント
├── AGENTS.md
└── docker-compose.yml
```

## リリース名
- Repository: `veil`
- Display name: `VEIL`
- 初期目標: `v0.1.0`（MVP、API互換性は試験段階）
