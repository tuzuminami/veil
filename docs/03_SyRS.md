# 03. SyRS — システム要求仕様
    **参照:** ISO/IEC/IEEE 29148、品質特性はISO/IEC 25010を参照。

    ## 1. 機能要求
    | ID | 要求 | 受入条件 |
|---|---|---|
| FR-VEI-001 | PolicyBundleをVersion付き・署名可能な形式で登録、検証、公開できる。 | 公開済みPolicyVersionは不変で、検証失敗時は公開不可とする。 |
| FR-VEI-002 | DecisionRequestに対しALLOW、TRANSFORM、REQUIRE_CONFIRMATION、BLOCK、ESCALATEのいずれかを返す。 | 判定不能・タイムアウト時はALLOWを返さずESCALATEまたはBLOCKにする。 |
| FR-VEI-003 | AgeAssuranceClaim、BoundaryDeclaration、tenant設定を判定条件へ組み込める。 | 年齢条件未充足の規則は明示的な安全側結果を返す。 |
| FR-VEI-004 | 外部分類器・ルールエンジン・人手レビューをAdapterとして組み合わせられる。 | Adapterごとにtimeout、信頼度、fallbackが設定できる。 |
| FR-VEI-005 | 判定根拠、適用規則、PolicyVersion、相関IDを監査記録として保持する。 | Decisionの再現に必要な入力ハッシュと規則IDを保存する。 |
| FR-VEI-006 | 誤判定申立てを受付け、元Decisionとレビュー結果を関連付けられる。 | AppealはDecision IDなしで作成できない。 |

    ## 2. 非機能要求
    | ID | 要求 | 受入条件 |
|---|---|---|
| NFR-001 | Tenant分離 | 全読取・更新・削除クエリにtenant_idが必須。越境試験は403または404。 |
| NFR-002 | 認証・認可 | 全変更APIでactorとscopeを検証。匿名変更を許可しない。 |
| NFR-003 | 可用性と縮退 | 外部依存のtimeoutは設定可能。安全上重要な依存失敗ではfail-closed。 |
| NFR-004 | 観測性 | 全HTTP要求・外部呼出し・状態遷移にcorrelation IDを付与。 |
| NFR-005 | 性能 | 標準的な同期APIは依存成功時p95 300ms以下を目標。重い処理は非同期ジョブ化。 |
| NFR-006 | 保守性 | domain / adapter / transportを分離し、依存方向をlintまたはarchitecture testで検証。 |
| NFR-007 | 移植性 | LinuxコンテナとPostgreSQLで稼働。クラウド固有SDKをcoreへ導入しない。 |
| NFR-008 | データ保護 | Secretをログ・例外・fixtureに出力しない。Sensitiveデータの保持期間を設定可能にする。 |

    ## 3. データ完全性要求
    - すべての変更可能リソースは`id`、`tenantId`、`createdAt`、`createdBy`、`version`を持つ。
    - 追記専用の監査イベントは物理更新を禁止し、訂正は後続イベントで表現する。
    - 楽観ロックまたはVersion条件を使い、lost updateを防止する。
    - request id / idempotency keyを受け付ける変更APIは、再送による副作用の重複を防止する。

    ## 4. セキュリティ要求
    - 認可前にデータ存在を詳細に漏らさない。
    - 監査ログは本文よりもID、ハッシュ、理由コードを優先する。
    - SecretはSecretReferenceで参照し、APIのGET／export対象から除外する。
    - 開発用seedデータは実在の個人情報を含めない。

    ## 5. 互換性要求
    - RESTは`/v1`で開始する。
    - 破壊的変更は新API versionまたは明示されたdeprecation期間を設ける。
    - Plugin SPIはcore APIと別のSemVer範囲で管理し、互換性テストを公開する。
