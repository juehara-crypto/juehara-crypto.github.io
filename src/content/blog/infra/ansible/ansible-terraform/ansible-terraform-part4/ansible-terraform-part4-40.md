---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第40回：改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル'
description: '第31回〜第39回で扱ってきた個々の改善を、手動実行から状態連携、CI/CD化、自動収束に至る成熟度モデル（Level 1〜4）として整理し直す。レベルが上がっても解消されない構造上のギャップと、導入コストとのトレードオフを踏まえて第4部を総括する。'
pubDate: 2026-09-05
category: 'infra'
tags: ['Ansible', 'Terraform', 'CI/CD', '成熟度モデル', '総括']
seriesId: 'ansible-terraform-part4'
seriesNo: 40
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [成熟度モデルの4段階](#2-成熟度モデルの4段階)
3. [第31〜39回の各回をレベルに対応づける](#3-第3139回の各回をレベルに対応づける)
4. [レベルが上がっても変わらないもの](#4-レベルが上がっても変わらないもの)
5. [レベルごとの導入コストと効果のトレードオフ](#5-レベルごとの導入コストと効果のトレードオフ)
6. [今後初めて遭遇する問題への向き合い方](#6-今後初めて遭遇する問題への向き合い方)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

第31回から第39回で扱ってきた9個の改善を振り返ったとき、これらは互いに独立した9個のテクニックだったのでしょうか。

**[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)** では、伝統的な運用知識とIaC特有の知識という2つの知識軸から、第1回から第38回までを振り返りました。第40回となる今回は、第4部（**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** 〜 **[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**）で扱ってきた個々の改善を、成熟度という一本の軸に沿って並べ直します。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**（状態出力による疎結合設計）は手動実行からの最初の脱却であり、**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** ・**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**（CI上でのE2E実行・検証）はその先の自動化であり、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**（定期的な差分検知と自動収束）はさらにその先にあります。これらは、「人手に依存する範囲をどこまで減らせるか」という一本の軸の上に並べることができます。

この回で扱う問いは、「この段階を理解すれば、今後別のパイプラインを設計する際にも、今どのレベルにいて次に何を目指すべきかを判断できるのではないか」です。

次のセクションでは、この回の土台となる、成熟度モデルの4段階を定義します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 成熟度モデルの4段階

この回の土台となる枠組みを示します。

プロビジョニング自動化の成熟度を、次の4段階で定義します。

```
Level 1：手動実行
　└─ ローカルでterraform apply・ansible-playbookを手打ちする

Level 2：状態連携
　└─ Terraformのoutputを介して、Ansibleが情報を非同期に受け取る

Level 3：CI/CD化
　└─ コードのプッシュをトリガーに、検証・実行・状態確認までを自動化する

Level 4：自動収束
　└─ 定期的な差分検知と、検知結果に応じた自動的な是正
```

Level 1は、コマンドを実行者が都度手打ちする状態です。Level 2は、Terraformの`output`を介してAnsibleが情報を受け取る、実行タイミングが分離された状態です。Level 3は、コードのプッシュをトリガーに、検証から実行、状態確認までが自動的に走る状態です。Level 4は、定期的な差分検知と、検知結果に応じた自動的な是正が組み込まれた状態です。

各レベルは、前段階を否定するものではありません。Level 2はLevel 1の実行内容（`terraform apply`・`ansible-playbook`というコマンド自体）を置き換えるのではなく、その実行タイミングと情報の受け渡し方を変えるものです。同様に、Level 3はLevel 2の疎結合設計を土台にしてCI基盤に載せ、Level 4はLevel 3の自動実行の仕組みを土台にして定期実行を組み込みます。前段階の上に新しい仕組みを積み重ねる形で、成熟度が上がっていく構造です。

次のセクションでは、第31回から第39回のそれぞれが、この4段階のどこに対応するかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 第31〜39回の各回をレベルに対応づける

第4部全体を俯瞰する一覧を示します。

第31回から第39回のそれぞれが、どのレベルの実現に対応していたかを表で整理します。

|回|改善内容|対応するレベル|
|---|---|---|
|**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**|状態出力を介した疎結合設計|Level 1 → Level 2 への移行|
|**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**|GitHub Actions上でのE2E自動化|Level 3|
|**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**|`triggers`による実行要否の判断|Level 3を支える最適化|
|**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**|Testinfraによる独立した状態検証|Level 3を支える検証の追加|
|**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**|Terraformモジュール・Ansibleロールの共通化|Level 3を支える保守性の改善|
|**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**|プラグイン・パッケージのキャッシュ|Level 3を支える効率化|
|**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|定期実行による構成ドリフトの自動検知と収束|Level 4|
|**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**|仕様書・構成図の自動生成|Level 3を支えるドキュメント面の改善|

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** がLevel 1からLevel 2への移行そのものであり、**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** から **[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)** はLevel 3を実現、維持するための個別の要素技術、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で初めてLevel 4に到達する、という構造が確認できます。

ただし、「Level 3を支える」という位置づけの中身は一様ではありません。**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)** は、それまでの回が扱ってきた「いつ、どういう順序で実行するか」という設計とは異なり、「実行するかどうか」という判断そのものをTerraformの状態管理に組み込む改善でした。**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** は、TerraformとAnsibleそれぞれの成功報告が互いの管理範囲を検証し合っていないという空白地帯に対し、両者に依存しない第三者の検証を追加するものでした。

また、**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)** のキャッシュと **[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)** のドキュメント自動生成は、いずれも改善の効果がTerraform側とAnsible側で対称ではありませんでした。**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)** では、apt-cacher-ngによるAnsible側のパッケージキャッシュは明確な高速化が確認できた一方、Terraformのプラグインキャッシュは、この検証環境の規模、回線条件ではむしろキャッシュなしの方が速いという結果でした。**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)** では、`terraform-docs`によるTerraform側のドキュメント自動生成は機能した一方、Ansible側で試した`ansible-autodoc`は、`PyYAML`の破壊的変更に追従できておらず動作しませんでした。Level 3を支える改善であっても、その効果は対象や環境の条件によって一様ではない、という点はこの表だけでは見えてこない部分です。

次のセクションでは、この成熟度モデルの中で、レベルが上がっても変わらないものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. レベルが上がっても変わらないもの

この回の核心を示します。

Level 4に到達しても、TerraformとAnsibleがそれぞれ自分の管理範囲しか見ていないという構造そのものは変わりません。この点を、**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** ・**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の内容を踏まえて確認します。

```
第34回で確認したこと：
　terraform apply の成功 → tfstateとの整合性のみを示す
　ansible-playbook の成功 → 各タスクの実行結果のみを示す
　　　　↓
　両者はそれぞれ自分の管理範囲の中でのみ成功を報告しており、
　パイプライン全体が意図通りかまでは、どちらの報告からも保証されない

第37回で確認したこと：
　terraform plan → Terraformが管理するリソース定義とtfstateの差分のみ検知
　ansible-playbook --check → 対象に実際に接続し、現在の状態との差分を検知
　Testinfra（第34回） → Ansibleの実行結果とは独立した経路で、タスクが依拠する前提条件を確認
　　　　↓
　3つはそれぞれ異なるレイヤーを検知する補完関係にあり、代替関係ではない
```

**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** で確認した通り、`terraform apply`の成功はtfstateとの整合性を、`ansible-playbook`の成功は各タスクの実行結果を、それぞれ自分の管理範囲の中でのみ示しています。両者を足し合わせても、パイプライン全体として意図した状態になっているかどうかは、直接には保証されません。

**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、`docker exec`による手動改ざんに対して、`terraform plan`はコンテナ内部の変更を一切検知できませんでした。検知できたのは`ansible-playbook --check`でした。あわせて、**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** で導入したTestinfraは、これら2つとは異なるレイヤー（Ansibleが実行するタスクの成否ではなく、そのタスクが依拠している前提条件）を、独立した経路で確認する仕組みでした。この3つは代替関係ではなく、それぞれ異なるレイヤーを検知する補完関係にあります。

Level 4の「自動収束」は、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で確認した通り、`ansible-playbook --check`による検知結果に応じて本実行を条件分岐させる仕組みでした。この仕組みが対処しているのは、あくまで「Playbookが管理している範囲」の差分です。Terraformが管理するリソース定義の外側にある変更、Playbook自体が把握していない構成要素の変更は、この自動収束の対象になりません。

自動化のレベルを上げることは、TerraformとAnsibleがそれぞれ自分の管理範囲しか見ていないという構造上のギャップそのものを解消することを意味しません。Level 4に到達しても、このギャップは残り続けます。自動化が整えるのは、そのギャップを検知し、対処する仕組みの側です。

次のセクションでは、この成熟度モデルにおける、レベルごとの導入コストと効果のトレードオフを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. レベルごとの導入コストと効果のトレードオフ

単純な優劣づけを避けるため、レベルが上がるごとに必要になる運用対象の増加を整理します。

|レベル|必要になるもの|
|---|---|
|Level 1|特になし（コマンドを打てる環境のみ）|
|Level 2|`terraform output`と連携する動的インベントリの設計|
|Level 3|CI基盤（GitHub Actions等）の運用、ワークフローの保守|
|Level 4|定期実行のスケジュール管理、検知結果の監視|

Level 1からLevel 2への移行は、既存の`local-exec`経由の実行を、疎結合な設計に置き換える設計変更が中心です。**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** で確認した通り、この移行によって、TerraformとAnsibleの実行順序を保証する仕組みがなくなるという新しい課題が生じました。Level 3への移行は、この課題への対処としてCI基盤を新たに運用対象に加えます。Level 4への移行は、Level 3で構築した自動実行の仕組みに加えて、定期実行のスケジュールと、検知結果を監視する運用が新たに必要になります。

レベルが上がるごとに、運用対象は増えていきます。小規模な検証環境やプロジェクトの初期段階では、Level 2程度で十分に運用できる場合も多く、Level 3・Level 4への移行は、変更頻度の高さやチーム人数の多さといった、運用対象の増加に見合うだけの利点があるかどうかで判断すべき事柄です。「レベルが高いほど優れている」という単純な図式ではありません。

このトレードオフは、個々の改善の内部にも表れます。**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)** で確認した通り、効率化を目的とした改善であっても、効果は対象や環境の条件によって一様ではありません。apt-cacher-ngによるAnsible側のパッケージキャッシュは、2台目以降で明確な高速化が確認できましたが、Terraformのプラグインキャッシュは、この検証環境の規模、回線条件では、キャッシュなしの方が速いという結果でした。同じ「Level 3を支える効率化」という位置づけの改善であっても、実際に運用対象を増やすだけの見返りがあるかどうかは、個別に見極める必要があります。

次のセクションでは、この成熟度モデルの考え方が、今後初めて遭遇する問題にどう向き合えるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 今後初めて遭遇する問題への向き合い方

この成熟度モデルの考え方は、TerraformとAnsibleという組み合わせに限った話ではない可能性があります。

第2節から第5節で整理してきたのは、「人手に依存する範囲をどこまで減らせるか」という一本の軸に沿って、手動実行から状態連携、CI/CD化、自動収束へと段階的に積み上がっていく構造でした。この構造自体は、構成管理ツールと別のインフラ定義ツールの組み合わせなど、このシリーズで扱わなかった別のツールの組み合わせにも、同じ段階を踏んで当てはめられる可能性があります。

読者が今後、このシリーズで扱わなかった別のツールの組み合わせで問題に直面したとき、「今、自分たちのパイプラインはどのレベルにあり、次にどのレベルを目指すべきか」を判断する枠組みとして、この4段階の考え方が応用できるかもしれません。ただし、これはあくまで一つの見方であり、すべての組み合わせに同じ4段階がそのまま当てはまると断定するものではありません。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* 第31回から第39回で扱ってきた改善は、「人手に依存する範囲をどこまで減らせるか」という一本の軸に沿って、手動実行（Level 1）、状態連携（Level 2）、CI/CD化（Level 3）、自動収束（Level 4）という一連の成熟度として整理できる。
* **[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** はLevel 1からLevel 2への移行、**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** から **[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)** はLevel 3を実現、維持するための個別の要素技術、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** はLevel 4への到達に対応する。ただし「Level 3を支える」改善の中身は一様ではなく、実行要否の判断（**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**）、第三者検証の追加（**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**）など、性質の異なる改善が含まれる。
* Level 4に到達しても、TerraformとAnsibleがそれぞれ自分の管理範囲しか見ていないという構造上のギャップは解消されない。**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** ・**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で確認した通り、`terraform plan`・`ansible-playbook --check`・Testinfraはそれぞれ異なるレイヤーを検知する補完関係にあり、自動化が整えるのは、このギャップを検知、対処する仕組みである。
* レベルが上がるほど運用対象も増えるため、必ずしも高いレベルを目指すことが常に最適とは限らない。**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)** で確認した通り、効率化を目的とした改善であっても、効果は対象や環境の条件によって一様ではない。
* この成熟度モデルの考え方は、TerraformとAnsibleという組み合わせに限らず、他のツールの組み合わせにも応用できる可能性がある。

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)** では、パイプラインの実行順序、検証、コード構造、待ち時間、変化の検知、ドキュメント化という、個々の改善を積み重ねてきました。第40回となる今回は、これらの改善を、手動実行から自動収束に至る一連の成熟度として整理し直しました。各回がLevel 1〜4のどこに対応するかを確認したうえで、レベルが上がっても、TerraformとAnsibleがそれぞれ自分の管理範囲しか見ていないという構造上のギャップは解消されないこと、そして成熟度を上げることが導入コストとのトレードオフであることを整理し、第4部（改善、CI/CD自動化編）を締めくくりました。

第5部（Terraformライフサイクル破壊編）からは、視点がさらに変わります。ここまでの第4部が「どう自動化し、どう改善するか」を扱ってきたのに対し、第5部は、TerraformのState管理そのものが持つ構造的な限界に踏み込みます。次回は、TerraformのState管理メカニズムと、Ansibleが変更するコンテナ内部状態の間にある「認識の不可視性」を扱います。

**[次回：第41回：なぜTerraformはAnsibleが投じた設定を知らないのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)　｜　[次の記事：【Ansible×Terraform編】第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第4部：改善、CI/CD自動化編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**|状態出力を介した疎結合なパイプライン設計|Terraformの`output`を中間データ（JSON/Environment）として抽出し、Ansibleの動的インベントリや変数として渡すパイプラインの分離設計。|
|**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**|GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築|CI/CD（GitHub Actions）上でTerraform実行によるコンテナ起動からAnsible適用までの自動テスト（E2E）を組み込む手法。|
|**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**|`triggers`を用いたAnsible再実行の最適化設計|`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を使い、設定ファイル変更時のみAnsibleを発火させる設計。|
|**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**|Testinfraによる状態検証を組込んだCI/CDパイプライン|Ansible適用後の状態（ポート、ファイル、プロセス）をTestinfra（Python）でテストし、パイプラインの成否を判定する自動化設計。|
|**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**|共通パーツのモジュール化（Terraformモジュール／Ansibleロール）|Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターン。|
|**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**|プラグインおよびパッケージのキャッシュによる開発効率の向上|Terraformのプラグインキャッシュとaptパッケージキャッシュにより、検証サイクルの待ち時間を短縮する手法。|
|**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|定期実行による構成ドリフトの自動検知と収束パイプライン|スケジュール実行（Cron／GitHub Actions）で`ansible-playbook --check`を流し、実際の構成差分（ドリフト）を検知し、差分があった場合のみ本実行して自動収束させる設計。|
|**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**|インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成|`terraform-docs`や`ansible-autodoc`等を活用し、コード更新と同時に仕様書や依存関係図を自動更新するパイプライン構築。|
|**[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**|既存インフラ運用知識とInfrastructure as Code（IaC）のシナジー|手動運用（CLI/Shell）のノウハウを、TerraformとAnsibleという2大ツールにどう分解、再構築していくかの比較考察。|
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|

---

[↑ 目次に戻る](#-目次)

---