---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第20回：運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案'
description: '第11回〜第19回で扱った運用、ライフサイクル編の個別事象を、ミュータブル運用とイミュータブル運用という軸で整理し直す。両運用思想の利点・欠点、TerraformとAnsibleの役割分担の重心の変化を踏まえ、リソースの性質による使い分けという折衷案を示す。'
pubDate: 2026-08-22
category: 'infra'
tags: ['Ansible', 'Terraform', 'ミュータブル', 'イミュータブル', '運用設計']
seriesId: 'ansible-terraform-part2'
seriesNo: 20
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ：TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [第11〜19回をミュータブル/イミュータブルの軸で再整理する](#2-第1119回をミュータブルイミュータブルの軸で再整理する)
3. [ミュータブル運用の特性](#3-ミュータブル運用の特性)
4. [イミュータブル運用の特性](#4-イミュータブル運用の特性)
5. [TerraformとAnsibleの役割の変化](#5-terraformとansibleの役割の変化)
6. [折衷案：リソースの性質による使い分け](#6-折衷案リソースの性質による使い分け)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** から **[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** にかけて、構築後の継続運用で直面するトラブルを一つずつ扱ってきました。手動変更によるドリフト、初期化処理によるOS設定の上書き、リソースの強制再生成、Playbookの冪等性、tfstateの整合性、パッケージアップデートによる非互換、IPアドレスの変動、機密情報の役割分担、OSのメジャーバージョンアップ。これらは個別に見ると独立した問題ですが、今回はこれらを振り返るのではなく、「なぜこの問題が起きるのか」という共通の軸で整理し直します。

その軸となるのが、「リソースを直し続けて使うか、使い捨てて入れ替えるか」という運用思想の違いです。前者を一般にミュータブル運用、後者をイミュータブル運用と呼びます。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** から **[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** で扱ってきた事象の多くは、この2つの運用思想のどちらに近い性質を持つかによって整理し直すことができます。

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** では、OSのメジャーバージョンアップというTerraform側の能動的な操作が、Ansible側のPlaybookにどう影響するかを実機で確認しました。今回はこの個別の事象から離れ、第2部（第11〜19回）全体を俯瞰する回になります。

この回で扱う問いは、「両ツールを使う以上、ミュータブル運用とイミュータブル運用のどちらに寄せるべきか、あるいはどう折衷するか」です。

次のセクションでは、まず第11〜19回の事象を、ミュータブル/イミュータブルの軸で再整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 第11〜19回をミュータブル/イミュータブルの軸で再整理する

第2部で扱った各回を、運用思想の軸で分類します。

|回|事象|運用思想との関係|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更ドリフトの検知|ミュータブル型（直し続けることが前提）|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|初期化処理変更によるリソース再生成・設定消失|イミュータブル型（作り直しが起点）|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|リソース定義変更による強制再生成|イミュータブル型（作り直しが起点）|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|Playbook複数回実行時の冪等性|両方に関わる（どちらの運用でも再実行は発生する）|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|tfstateの整合性維持|ミュータブル型寄り（長期間同じ環境を保守する前提）|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|パッケージアップデート非互換|ミュータブル型（同じリソースを使い続けるからこそ発生する）|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|IPアドレス変動と接続情報の更新遅延|イミュータブル型（再生成が起点）|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|機密情報の役割分担|両方に関わる（運用思想に関わらず必要な設計）|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|OSメジャーバージョンアップ|両方に関わる（ベースイメージ切り替えという能動的なイミュータブル操作だが、検証・移行は段階的に進める必要がある）|

この表を見ると、第2部全体がミュータブル運用とイミュータブル運用のどちらかに偏っていたわけではないことが分かります。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** はリソースを直し続けて使うことを前提にした問題であり、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**、**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)** はリソースを作り直すことそのものが起点になった問題でした。そして **[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** は、どちらの運用思想を採用していても向き合う必要がある問題です。

第2部が扱ってきたトラブルの背後には、こうした2つの運用思想が混在する状態が前提としてあり、その混在自体が問題の起きやすさに関わっていたことが見えてきます。次のセクションでは、まずミュータブル運用そのものの特性を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. ミュータブル運用の特性

ミュータブル運用の特性を整理します。

リソースを直し続けて使う運用には、次のような利点があります。

* リソース内部のデータや状態がそのまま維持される（再生成によるデータ消失リスクがない）
* 物理的、仮想的なリソースに制約がある環境と相性がよい

一方で、次のような欠点も抱えます。

* **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で扱った手動変更ドリフトが蓄積しやすい
* **[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** で扱った冪等性の管理負担が、運用の長期化とともに増える
* **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** で扱ったパッケージアップデートによる非互換リスクを抱え続ける

これらの欠点に共通しているのは、同じリソースを使い続けるからこそ、時間の経過とともに状態がずれていく、あるいは前提が古くなっていくという構造です。ミュータブル運用は、リソースを作り直すコスト（確保や再構築の手間）が高い環境では、自然とこの運用思想に寄りやすくなります。

次のセクションでは、対照的な性質を持つイミュータブル運用の特性を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. イミュータブル運用の特性

イミュータブル運用の特性を整理します。

リソースを使い捨てて入れ替える運用には、次のような利点があります。

* ドリフトが蓄積する前にリソースごと入れ替えるため、ドリフト問題を根本的に回避できる
* 常にクリーンな状態からスタートするため、動かなくなった原因の切り分けが単純になる

一方で、次のような欠点も抱えます。

* **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** で扱ったリソース再生成によるOS内部データの消失リスクを常に抱える
* **[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)** で扱ったIPアドレス変動への追従が常に必要になる
* リソースの作り直しに伴うコスト（時間、リソース利用料）が発生する

これらの欠点に共通しているのは、リソースを入れ替えるたびに、内部の状態や接続情報がゼロから作り直される、あるいは変動しうるという構造です。ミュータブル運用が「同じリソースを使い続けるからこそ生じる問題」を抱えていたのに対し、イミュータブル運用は「作り直すからこそ生じる問題」を抱えているという、対照的な関係にあります。リソースの作り直しが容易な環境では、この運用思想に寄せやすくなります。

次のセクションでは、この2つの運用思想によって、TerraformとAnsibleそれぞれの役割の重心がどう変わるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. TerraformとAnsibleの役割の変化

運用思想によって、TerraformとAnsibleの役割分担の重心がどう変わるかを整理します。

```plaintext
ミュータブル運用の場合
　Terraform：初期構築時のみ主に使う
　Ansible：継続的な構成管理、ドリフト是正が主役

イミュータブル運用の場合
　Terraform：リソースの作成、破棄を頻繁に担う主役
　Ansible：作り直すたびの初期設定投入が役割（継続的なドリフト是正の比重は下がる）
```

ミュータブル運用では、リソースそのものは初回構築後ほとんど変わらず、Ansibleが継続的にOS内部の状態を整え続ける役割を担います。第3節で見た欠点、ドリフトの蓄積や冪等性の管理負担は、この役割の重さがそのまま表れたものです。

一方、イミュータブル運用では、リソースの作成と破棄そのものが運用の中心になり、Terraformが主役の位置に移ります。Ansibleは、作り直されたリソースに対して初期設定を投入する役割に限定され、ミュータブル運用のように長期間にわたってドリフトを是正し続けるという役割は後退します。

この構造は、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)** で整理した「リソース生成はTerraform、構成管理はAnsible」という基本的な役割分担そのものを覆すものではありません。両ツールが担うレイヤーの境界は変わらないまま、運用フェーズに入ってどちらの運用思想を採用するかによって、どちらのツールがより中心的な役割を果たすかという重心だけが変わる、という関係です。

次のセクションでは、この2つの運用思想を踏まえたうえで、この回の結論となる折衷案を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 折衷案：リソースの性質による使い分け

この回の結論となる折衷案を整理します。

ここまで見てきたミュータブル運用とイミュータブル運用は、どちらも一長一短であり、片方が一方的に優れているという関係ではありません。すべてのリソースを一律にイミュータブルへ寄せる必要はなく、リソースの性質によって使い分けるという考え方が現実的な着地点になります。

|リソースの性質|向いている運用|理由|
|---|---|---|
|ステートフルなリソース（DB、ストレージ等）|ミュータブル寄り|データの消失リスクが致命的になるため|
|ステートレスなリソース（アプリケーションサーバー等）|イミュータブル寄り|データを保持しないため、使い捨てによる影響が小さい|

ステートフルなリソースは、第4節で見たイミュータブル運用の欠点、リソース再生成に伴うデータ消失リスクをそのまま引き受けることになるため、直し続けて使うミュータブル運用の方が向いています。一方、ステートレスなリソースはデータを保持しないため、作り直しても失うものが少なく、第4節で見たイミュータブル運用の利点、ドリフトの根本回避や原因切り分けの単純化を素直に活かせます。

この使い分けにおいて、ステートフルなリソースを保持しながら安全に再構築する具体的な設計パターン（Volumeの分離など）は、この回では扱いません。この領域は第5部、**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で個別に扱う内容になります。今回押さえておきたいのは、「性質によって使い分ける」という考え方そのものです。

次のセクションでは、この回で整理した内容を改めてまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** から **[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** で扱った問題は、「リソースを直し続けて使うか、使い捨てて入れ替えるか」というミュータブル運用とイミュータブル運用の軸で整理し直せる。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** はミュータブル型、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**、**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)** はイミュータブル型、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**、**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** はどちらの運用でも向き合う必要がある問題として位置づけられる
* ミュータブル運用は、リソース内部のデータや状態がそのまま維持されるという利点を持つ一方、ドリフトの蓄積や冪等性の管理負担、パッケージアップデートによる非互換リスクを抱え続けるという欠点がある
* イミュータブル運用は、ドリフトを根本的に回避でき原因の切り分けが単純になるという利点を持つ一方、リソース再生成によるデータ消失リスクとIPアドレス変動への追従コストを抱えるという欠点がある
* 運用思想によって、TerraformとAnsibleのどちらが主役になるかの重心が変わる。ミュータブル運用ではAnsibleが継続的な構成管理を担い、イミュータブル運用ではTerraformがリソースの作成、破棄を頻繁に担う
* すべてのリソースを一律にイミュータブルへ寄せる必要はなく、ステートフルなリソースはミュータブル寄り、ステートレスなリソースはイミュータブル寄りという、リソースの性質による使い分けが現実的な折衷案になる

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** では、Terraform側でベースイメージを新しいOS世代に切り替える操作が、Ansibleの実行対象OSを一気に変えるという構造を確認しました。

今回は視点を切り替え、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** から **[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)** で扱ってきた個別の事象を、ミュータブル運用とイミュータブル運用という共通の軸で整理し直しました。両運用思想それぞれの利点と欠点、TerraformとAnsibleの役割分担の重心の変化を踏まえ、リソースの性質による使い分けという折衷案を整理し、第2部（運用、ライフサイクル編）を締めくくります。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** からは第3部（トラブルシューティング、デバッグ編）に入ります。視点は「設計、運用」から「障害発生時の原因特定」に移り、Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側なのかAnsible側なのかを切り分ける手法を扱います。

**[次回：第21回：統合実行時におけるネストされたエラーログの解析手法](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)　｜　[次の記事：【Ansible×Terraform編】第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ：TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用、ライフサイクル編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更による構成ドリフトの検知と同期手法|構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が出る問題。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|`terraform apply`実行時における初期化処理とOS設定の上書き問題|Terraform側で初期化スクリプトやコンテナ起動定義を書き換えて再実行した際、Ansibleによって設定済みのOS内部状態が初期化される課題。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|コード修正に伴うリソースの強制再生成（リビルド）リスク|TerraformのHCL定義変更によって、リソースが「更新」ではなく「破棄、再生成」され、Ansibleが投入した内部データが消失する課題。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|複数回実行時におけるAnsible Playbookの冪等性の確保|`terraform apply`のlocal-exec経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookがterraform apply自体の失敗を引き起こす問題。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|チーム運用における状態管理ファイル（tfstate）の整合性維持|Ansibleを実行するオペレーターと、Terraformを管理するエンジニア間で、Terraformの状態管理ファイルに競合が発生するリスク。チーム運用での役割分担設計も整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|パッケージアップデートに伴う環境の非互換性への対応|運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケース。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソース再生成時におけるIPアドレス変動と接続情報の更新遅延|リソース（コンテナ/VM）の再生成に伴ってIPアドレスが変更された際、Ansible用のインベントリや各種設定ファイルの書き換えが追いつかない問題。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|TerraformとAnsible Vaultにおける機密情報の役割分担|データベースのパスワードやAPIキーなどの機密情報を、両ツールのどちらで暗号化し、どのように管理すべきかの運用設計。Vault誤用パターンと回避策も整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|OSのメジャーバージョンアップ時におけるPlaybookの互換性検証|Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる課題。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**|運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案|状態（データ）を維持し続ける運用（ミュータブル）と、使い捨てる運用（イミュータブル）を、両ツールの組み合わせでどのように着地させるかの最適解。|

---

[↑ 目次に戻る](#-目次)

---
