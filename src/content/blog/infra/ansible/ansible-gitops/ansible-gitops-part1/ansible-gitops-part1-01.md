---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1回：なぜ「Gitがインフラの唯一の真実」なのか'
description: 'GitOpsの4原則を評価軸として、AnsibleとTerraformがそれぞれどの原則を満たし、どの原則を満たさないのかを整理する。push型構成の立ち位置を示したうえで、Gitを経由しない手動変更、tfstateの観測範囲外で起きる変化、収束処理が走らない期間という、「Gitが唯一の真実」が崩れる3つの経路を示し、そのうち2つを実機で確認する。'
pubDate: 2026-09-27
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'ドリフト']
seriesId: 'ansible-gitops-part1'
seriesNo: 1
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/'
relatedSeries: ''
---


<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [GitOpsの4原則を評価軸として分解する](#2-gitopsの4原則を評価軸として分解する)
3. [Terraformは4原則のどこを満たすのか](#3-terraformは4原則のどこを満たすのか)
4. [Ansibleは4原則のどこを満たすのか](#4-ansibleは4原則のどこを満たすのか)
5. [push型とpull型：本シリーズの立ち位置](#5-push型とpull型本シリーズの立ち位置)
6. [「唯一の真実」が崩れる3つの経路](#6-唯一の真実が崩れる3つの経路)
7. [3つの経路とシリーズ構成の対応](#7-3つの経路とシリーズ構成の対応)
8. [Dockerプロバイダー以外でも同じ構造になる理由](#8-dockerプロバイダー以外でも同じ構造になる理由)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

Terraformで仮想マシンやコンテナを作成し、その内部の設定をAnsibleで投入する構成を運用していて、

* コードはGitで管理している
* CIで`terraform apply`と`ansible-playbook`を実行している
* この運用はGitOpsである

と考えていないでしょうか。

GitOpsという言葉はKubernetesの文脈で広まり、解説記事の多くはArgo CDやFluxといったツールとセットで語られています。AnsibleやTerraformを題材にしたGitOpsの記事もありますが、その多くはどちらか一方のツールだけを扱っています。一方、AnsibleとTerraformを組み合わせて実際に運用すると、次のような場面にぶつかります。

* Gitには差分がないのに、実際のサーバーの状態がずれている
* `terraform plan`は「No changes」なのに、コンテナ内部の設定が変わっている
* プッシュのたびにインフラが変わることが不安で、結局は手動で確認している
* Ansible Vaultのパスワードをどこに置けばよいか決まらず、GitOps化が止まる

これらは別々の問題に見えますが、いずれも「Gitに書かれた内容」と「実際のインフラの状態」が一致しているとは限らない、という点で共通しています。

このずれは、前シリーズ「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。第4部（**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** 〜 **[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**）では、GitHub ActionsでCI/CDのパイプラインを組み、定期実行によるドリフトの検知と自動収束までを自動化しました。**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)** では、手動実行から自動収束までの改善を段階的に整理したうえで、自動収束まで到達しても、AnsibleとTerraformがそれぞれ自分の管理範囲しか見ていないという構造上のギャップは残ることを確認しました。**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** では、tfstateがコンテナ内部のOSレイヤーを、そもそも観測対象に含めていないことを確認しました。

つまり、Ansible×Terraformシリーズを終えた時点で、インフラの状態を示すものは、実際の状態、tfstate、Playbookの3つに分かれたままです。tfstateはTerraformが管理するリソースの属性について、PlaybookはAnsibleが投入する内部の設定について、実際の状態は現在動いているインフラそのものについて、それぞれ別々の「真実」を持っています。

本シリーズ「Ansible×TerraformをGitOpsで回す」は、この3つに分かれた真実の基準をGitに置き、そこからのずれを検知して収束させる仕組みを、GitOpsの考え方に沿って組み立てていくシリーズです。検証環境ではTerraformのDockerプロバイダーを使いますが、扱う問題はDocker固有のものではなく、AWSやGCPなど他のプロバイダーでも同じ構造で起こります。各回では、どこをプロバイダー固有の記述に置き換えればクラウド環境に当てはまるかも、あわせて示します。

なお、このシリーズは、**[「Ansibleは本当に冪等なのか」〜冪等性が崩れる構造と設計〜](https://qiita.com/juehara-crypto/items/d77fa93e82ea4a33ef4f)**（以下、冪等性シリーズ）、**[「Ansibleは冪等なのに、なぜサーバは壊れていくのか」](https://qiita.com/juehara-crypto/items/2a375a2c0fca3a8df0ca)**（以下、ドリフトシリーズ）、**[「AnsibleのPlaybookが壊れる理由はテスト文化にあった」](https://qiita.com/juehara-crypto/items/194d5730466aef04ed44)**（以下、Moleculeシリーズ）、そしてAnsible×Terraformシリーズと内容的なつながりがあります。これらのシリーズが、Playbookの設計、Ansibleが実行されていない時間に起きるずれ、変更のたびに確認し続ける仕組み、複数ツールの連携で起きる問題をそれぞれ扱ったのに対し、本シリーズは、それらの変更をすべてGitに通し、CIで検証して適用する仕組みを扱います。これらのシリーズを読まれた方には答え合わせとして、初めて読まれる方には入り口として、読み進めていただける構成にしています。

第1回となる今回は、シリーズの起点として、GitOpsの原則を評価軸に、AnsibleとTerraformがそれぞれどこまでGitOpsの条件を満たしているのかを整理します。

正確に言うと、**Gitにコードを置くことと、Gitがインフラの唯一の真実であることは別物であり、その間を埋める仕組みがなければGitOpsは成立しません**。この回で扱う問いは、「Gitが唯一の真実と言い切るために、何が足りていないのか」です。

次のセクションでは、この問いを評価するための軸として、GitOpsの4原則を分解します。

---

[↑ 目次に戻る](#-目次)

---

## 2. GitOpsの4原則を評価軸として分解する

この回でAnsibleとTerraformを評価するための軸として、GitOpsの4原則を整理します。

GitOpsの原則は、GitOps Working Groupが監修するOpenGitOpsが、**[GitOps Principles v1.0.0](https://opengitops.dev/)** として公開しています。ここでは、原則の定義やGitOpsのメリットを解説するのではなく、以降のセクションでAnsibleとTerraformを評価するための4つの観点として使います。各原則の内容を要約し、この回で見る評価の観点と並べると、次のとおりです。

|原則|内容（要約）|評価の観点|
|---|---|---|
|1. 宣言型（Declarative）|管理対象のあるべき状態が、宣言的に表現されている|あるべき状態を、実行手順ではなく状態として書けるか|
|2. バージョン管理と不変性（Versioned and Immutable）|あるべき状態が、変更不可能で完全な履歴を残す形で保存されている|あるべき状態がGitに保存され、変更がすべて履歴として残るか|
|3. 自動的な取得（Pulled Automatically）|エージェントが、保存場所からあるべき状態を自動的に取得する|人やCIが実行を指示しなくても、適用する側があるべき状態を取り込むか|
|4. 継続的な収束（Continuously Reconciled）|エージェントが実際の状態を継続的に観測し、あるべき状態の適用を試み続ける|適用した後も実際の状態を観測し続け、ずれを戻し続けるか|

原則3・4の「エージェント」は、管理対象の側で常に動き続けるプログラムを指します。4原則はいずれも、Kubernetesや特定のツールを前提にした書き方になっていません。そのため、AnsibleとTerraformの構成にも、同じ観点をそのまま当てはめることができます。

4原則は、扱っている対象によって2つに分けられます。

```
【あるべき状態をどう書き、どう保存するか】
　原則1：宣言型
　原則2：バージョン管理と不変性

【保存したあるべき状態を、どう実際の状態に反映し続けるか】
　原則3：自動的な取得
　原則4：継続的な収束
```

原則1・2は、コードの書き方と保存場所の問題です。あるべき状態をコードとして書き、Gitに保存すれば、満たすための条件の多くがそろいます。一方、原則3・4は、保存したあるべき状態を、誰が、いつ、どのように実際の状態へ反映し、反映した後も見続けるかという、実行の仕組みの問題です。

「Gitが唯一の真実」と言えるかどうかは、原則3・4で決まります。あるべき状態がGitに正しく書かれていても、それを反映し、ずれを見続ける仕組みがなければ、実際の状態はGitの内容から離れていきます。なお、原則3は、エージェントが自ら取りに行く（pull）形を前提にしています。これに対し、本シリーズの構成は、CIが管理対象に向けて変更を押し込むpush型です。具体的には、GitHub ActionsからAnsibleとTerraformを実行して、変更を適用します。この前提の違いが、push型の構成にどう影響するかは、**[セクション5](#5-push型とpull型本シリーズの立ち位置)** で扱います。

次のセクションでは、この4つの観点に沿って、Terraformがどの原則を満たすのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. Terraformは4原則のどこを満たすのか

**[セクション2](#2-gitopsの4原則を評価軸として分解する)** の4つの観点で、Terraform単体がどこまでGitOpsの原則を満たすのかを整理します。

Terraformは、HCLで「どのリソースが、どの属性で存在すべきか」を宣言し、`terraform apply`でその状態に合わせます。適用した結果はtfstateに記録されます。`terraform plan`は、HCLの定義、tfstate、プロバイダーのAPIから取得した現在の属性を比較して、差分を計算します。あるべき状態を宣言として書き、現在の状態との差分を自ら計算できる点で、Terraformは宣言型のツールです。

ただし、この比較が及ぶのはリソースの属性までです。Ansible×Terraformシリーズの **[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** では、`terraform show`でtfstateの中身を確認しました。記録されているのは、イメージ、ポート、ネットワークといったリソースの属性であり、コンテナ内部のファイルやパッケージの状態を示す項目は存在しませんでした。同じ回では、コンテナ内部にファイルを作成しても`terraform plan`は「No changes」となる一方、`restart`のようなリソースの属性を変更した場合は差分として検出されることも確認しています。Terraformの宣言は、リソースの属性という範囲の中で成り立っています。

4原則との対応を整理すると、次のとおりです。

|原則|Terraform単体での充足|理由|
|---|---|---|
|1. 宣言型|範囲付きで満たす|HCLであるべき状態を宣言できる。ただし、対象はリソースの属性に限られる|
|2. バージョン管理と不変性|範囲付きで満たす|HCLはGitで管理できる。一方、差分計算のもう1つの基準であるtfstateは、通常Gitの外で管理する|
|3. 自動的な取得|満たさない|常駐するエージェントがなく、誰かが`terraform plan`や`terraform apply`を実行しない限り動かない|
|4. 継続的な収束|満たさない|`terraform plan`でリソースの属性のずれは検出できるが、実行したその時点に限られる。実行と実行の間は、何も観測していない|

原則2については、HCLとtfstateを分けて考える必要があります。HCLはGitで履歴を残せますが、Terraformが差分を計算するときに使うtfstateは、Gitの外にあります。Terraformの判断材料の一部は、最初からGit以外の場所にあるということです。tfstateの置き場所は第2部で、tfstateに含まれる機密情報の扱いは第3部で扱います。

原則3・4については、Terraformは差分を計算する能力を持っていますが、それを自ら繰り返し実行する仕組みを持っていません。差分を計算できることと、差分を見続けることは別です。Terraform単体では、原則1・2を範囲付きで満たす一方、原則3・4は、Terraformの外に実行の仕組みを用意して補う必要があります。

次のセクションでは、同じ4つの観点でAnsibleを整理し、Terraformと並べて比較します。

---

[↑ 目次に戻る](#-目次)

---

## 4. Ansibleは4原則のどこを満たすのか

**[セクション3](#3-terraformは4原則のどこを満たすのか)** と同じ4つの観点で、Ansible単体がどこまでGitOpsの原則を満たすのかを整理し、Terraformと並べて比較します。

Ansibleは、Playbookに書かれたタスクを上から順に実行する、手続き型のツールです。Terraformのtfstateのように、適用した結果を記録する状態ファイルを持ちません。その代わり、実行のたびに管理対象へ接続し、タスクごとに現在の状態を確認します。冪等性シリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-02/)** で整理したとおり、`file`、`copy`、`template`といったモジュールは、現在の状態とタスクに書かれたあるべき状態を比較し、差分がある場合だけ変更を加えます。Ansibleが宣言的に見えるのは、こうしたモジュールが状態の比較を内部で行っているためです。

ただし、すべてのタスクがこのように振る舞うわけではありません。冪等性シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-01/)** では、`shell`や`command`モジュールは現在の状態を観測しないこと、`changed_when`は`changed`の表示を制御するだけで、冪等性を保証するものではないことを整理しました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-idempotency/ansible-idempotency-04/)** では、`state: latest`を指定すると、あるべき状態の定義がパッケージのリポジトリという外部に委ねられ、Playbookを読むだけではあるべき状態が確定しないことを整理しました。Ansibleが宣言的に振る舞うかどうかは、ツールの性質ではなく、Playbookの設計で決まります。

4原則との対応を整理すると、次のとおりです。

|原則|Ansible単体での充足|理由|
|---|---|---|
|1. 宣言型|設計次第で満たす|冪等なモジュールで状態を書けば、宣言的に振る舞う。`shell`や`state: latest`を使うと、あるべき状態がPlaybookの中で確定しない|
|2. バージョン管理と不変性|設計次第で満たす|PlaybookはGitで管理でき、Gitの外に状態ファイルも持たない。ただし、`state: latest`のように、あるべき状態の一部をGitの外に委ねる書き方では、Gitの履歴だけではあるべき状態を再現できない|
|3. 自動的な取得|満たさない|管理対象にエージェントを置かず、制御ノードから接続して実行する。誰かが`ansible-playbook`を実行しない限り動かない|
|4. 継続的な収束|満たさない|`ansible-playbook --check`で実際の状態とPlaybookの差分は検出できるが、実行したその時点に限られる。また、検出できるのはタスクに書かれた範囲に限られる|

原則4の「タスクに書かれた範囲に限られる」という点は、ドリフトシリーズの **[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-02/)** で、`--check`で検知できるのはAnsibleが管理している範囲に限られ、`--check`で問題が出ないことはずれがないことの証明にならない、と整理した内容です。

Terraformと並べると、次のようになります。

|原則|Ansible|Terraform|
|---|---|---|
|1. 宣言型|設計次第で満たす|範囲付きで満たす（リソースの属性まで）|
|2. バージョン管理と不変性|設計次第で満たす|範囲付きで満たす（tfstateはGitの外）|
|3. 自動的な取得|満たさない|満たさない|
|4. 継続的な収束|満たさない|満たさない|

原則1・2は、どちらのツールも条件付きで満たしますが、その条件の性質が異なります。Terraformは、ツールの性質として宣言型であり、その範囲がリソースの属性に限られます。Ansibleは、ツールの性質としては手続き型であり、宣言的に振る舞うかどうかがPlaybookの設計に委ねられています。

差分を判断する基準も異なります。Terraformは、tfstateとプロバイダーのAPIから取得したリソースの属性を基準にし、管理対象の内部には入りません。Ansibleは、実行のたびに管理対象へ接続し、内部の実際の状態を直接確認します。ただし、確認するのはタスクに書かれた項目だけです。この違いが、Gitを経由しない変更を誰が検出できるかを分けます。この点は **[セクション6](#6-唯一の真実が崩れる3つの経路)** の実機確認で扱います。

原則3・4は、どちらのツールも単体では満たしません。「Gitが唯一の真実」を成り立たせるには、AnsibleとTerraformの外に、あるべき状態を反映し、ずれを見続ける実行の仕組みを用意する必要があります。

次のセクションでは、この実行の仕組みの作り方として、push型とpull型の違いを整理し、本シリーズの立ち位置を示します。

---

[↑ 目次に戻る](#-目次)

---

## 5. push型とpull型：本シリーズの立ち位置

**[セクション4](#4-ansibleは4原則のどこを満たすのか)** で、原則3・4はAnsibleとTerraformの外に実行の仕組みを用意する必要があると整理しました。ここでは、その仕組みの2つの型を比較し、本シリーズの立ち位置を示します。

実行の仕組みには、pull型とpush型があります。違いは、誰が、いつ、あるべき状態を管理対象に反映するかです。

```
【pull型】
管理対象の側で常駐するエージェントが、Gitを監視する
　↓
Gitの変更を自ら取得し、管理対象に適用する
　↓
適用後も実際の状態を観測し続け、ずれがあれば戻す

【push型】
Gitへの変更や定期実行をきっかけに、CIが起動する
　↓
CIがAnsibleとTerraformを実行し、管理対象に変更を押し込む
　↓
実行が終わると、次のきっかけまで何も観測しない
```

pull型の代表例は、Kubernetesで使われるArgo CDやFluxです。クラスタの中で常駐するエージェントがGitを監視し、変更を自ら取得して適用し、その後も実際の状態を観測し続けます。原則3・4は、この仕組みそのものに組み込まれています。GitOpsの解説がArgo CDやFluxとセットで語られることが多いのは、このためです。

一方、AnsibleとTerraformには、Argo CDやFluxのように管理対象の側で常駐し、観測し続けるエージェントがありません。Ansibleには、管理対象の側でリポジトリを取得してPlaybookを実行する`ansible-pull`がありますが、これもcronなどで定期的に起動する形で、実行と実行の間に観測を続けるものではありません。AnsibleとTerraformで仮想マシンやコンテナを管理する構成では、CIから実行するpush型が一般的な選択になります。

push型とpull型を、4原則に沿って並べると次のとおりです。

|原則|pull型|push型（本シリーズ）|
|---|---|---|
|1. 宣言型|コードの書き方で決まる（型による差はない）|コードの書き方で決まる（型による差はない）|
|2. バージョン管理と不変性|Gitで管理する（型による差はない）|Gitで管理する（型による差はない）|
|3. 自動的な取得|エージェントが自ら取得する|形としては満たさない。Gitへの変更をきっかけにCIが適用することで、人の操作なしに反映するという目的を代わりに満たす|
|4. 継続的な収束|エージェントが観測し続ける|満たさない。定期的な検知と収束を自前で作り、近づける|

原則1・2は、コードとGitの問題なので、型による差はありません。差が出るのは原則3・4です。

原則3について、push型は、エージェントが自ら取得するという形を満たしません。本シリーズでは、Gitへの変更（マージ）をきっかけにCIが適用する仕組みを作ることで、人が実行を指示しなくてもGitの内容が反映される状態を目指します。

原則4について、push型のCIは、実行が終わると観測を止めます。そのため、継続的な観測は、定期実行による検知と収束で近づけるしかありません。定期実行である以上、実行と実行の間には観測されない期間が残ります。Ansible×Terraformシリーズの **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、`ansible-playbook --check`の定期実行による検知と自動収束を作りました。ただし、実行のたびに使い捨てられるGitHubのホステッドランナーでは、常時起動しているインフラを外から監視できません。そのため、コンテナの起動から改ざんの注入、検知までを、1回のワークフロー実行の中で完結させる構成でした。本シリーズでは、管理対象と同じネットワーク内に置くself-hostedランナーを **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で採用し、稼働し続けるインフラに対する定期検知と自動収束を、第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）で作ります。

本シリーズの立ち位置は、「push型の構成で、GitOpsの4原則をどこまで満たせるか」を確かめることです。原則3は目的を代わりに満たし、原則4は自前の仕組みで近づけます。そのうえで、push型では埋めきれない部分がどこに残るかも、あわせて示していきます。Argo CDやFluxの導入や使い方は、本シリーズでは扱いません。

次のセクションでは、この構成のもとで「Gitが唯一の真実」が崩れる3つの経路を、実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 「唯一の真実」が崩れる3つの経路

「Gitが唯一の真実」という前提が崩れる経路を3つに整理し、そのうち2つを実機で確認します。

**[セクション3](#3-terraformは4原則のどこを満たすのか)** と **[セクション4](#4-ansibleは4原則のどこを満たすのか)** で見たとおり、AnsibleとTerraformは、それぞれ異なる基準で差分を判断し、どちらも単体では観測を続けません。このため、Gitに書かれた内容と実際の状態は、次の3つの経路で離れていきます。

* ① Gitを経由しない手動変更：管理対象に直接加えられた変更で、Gitの履歴には残らない
* ② tfstateの観測範囲外で起きる変化：コンテナ内部など、Terraformがリソースの属性として記録していない場所で起きる変化
* ③ 収束処理が走らない期間の放置：ずれが起きてから、次に検知や収束の処理が走るまでの期間

①と②は、同時に起こる場合があります。管理対象のコンテナ内部に直接加えた変更は、Gitを経由しない変更であり、同時にtfstateの観測範囲外の変化でもあります。ここでは、この1つの手動変更に対して、Git、Terraform、Ansibleの順に、それぞれが変更を検出できるかを確認します。③は、実機ではなく構造として整理します。

検証環境は、Terraformで作成したコンテナ3台（target-node1〜3）に、AnsibleのPlaybookで設定ファイルを配置した構成です。Playbookと構成ファイルは、Gitリポジトリで管理しています。Playbookが管理しているのは、次のタスクで配置する`/etc/drift-check-target.conf`です。

* **ファイル名：`roles/common_setup/tasks/drift_check.yml`**

```yaml
---
- name: ドリフト検知の実演用設定ファイルを配置
  become: true
  ansible.builtin.copy:
    dest: /etc/drift-check-target.conf
    content: "monitored_by=ansible-drift-check\n"
```

なお、手動変更を`terraform plan`が検出しないこと、`ansible-playbook --check` が検出することは、Ansible×Terraformシリーズの  **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で確認しています。ここで確認したいのは、同じ1つの変更に対して、Gitを含む3者の結果を並べたときに何が見えるかです。

### ■ 検証内容：Playbookが管理しているファイルの手動変更

まず、変更前の内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/drift-check-target.conf"
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
```

target-node1の`/etc/drift-check-target.conf`を、Ansibleを経由せずに書き換えます。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf"
```

変更後の内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/drift-check-target.conf"
```

**▼ 実行結果**

```plaintext
monitored_by=manual-edit
```

この状態で、Gitリポジトリの状態を確認します。

**実行コマンド**

```plaintext
git status
```

**▼ 実行結果**

```plaintext
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

続けて、`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

最後に、`ansible-playbook --check --diff`を実行します。

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml --check --diff
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] ********************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
--- before: /etc/drift-check-target.conf
+++ after: /etc/drift-check-target.conf
@@ -1 +1 @@
-monitored_by=manual-edit
+monitored_by=ansible-drift-check

changed: [target-node1]

TASK [疎通確認] *****************************************************************************************************************************************************************************
ok: [target-node2]
ok: [target-node3]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

同じ1つの手動変更に対する3者の結果を並べると、次のとおりです。

```
【Playbookが管理しているファイルの手動変更】
Git　　　　→ 検出しない（nothing to commit, working tree clean）
Terraform　→ 検出しない（No changes）
Ansible　　→ 検出する（target-node1のみchanged=1、変更前後の差分を表示）
```

Gitが検出しないのは、Gitが管理しているのが、リポジトリの中にあるPlaybookや構成ファイルだからです。管理対象の内部で起きた変更は、リポジトリの中のファイルを1つも変えないため、Gitの履歴にも差分にも現れません。これが経路①です。

Terraformが検出しないのは、**[セクション3](#3-terraformは4原則のどこを満たすのか)** で整理したとおり、コンテナ内部のファイルがtfstateの観測範囲外にあるためです。これが経路②です。

Ansibleだけが検出できたのは、実行のたびに管理対象へ接続し、タスクに書かれたあるべき状態と実際の状態を比較しているためです。つまり、Playbookが管理している範囲に限っては、Gitを経由しない手動変更を検出できるのは、3者のうちAnsibleの`--check`だけでした。

`--check`で検出した差分は、Playbookの本実行で収束させられます。次の補足確認に進む前に、target-node1を元の状態に戻します。

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] ********************************************************************************************************************************
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1]

TASK [疎通確認] *****************************************************************************************************************************************************************************
ok: [target-node2]
ok: [target-node1]
ok: [target-node3]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/drift-check-target.conf"
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
```

target-node1のみ`changed=1`となり、ファイルの内容が`monitored_by=ansible-drift-check`に戻りました。

### ■ 検証内容：Playbookが管理していないファイルの手動変更

次に、Playbookのどのタスクにも登場しないファイルを、target-node1に新しく作成します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "echo 'manual_setting=added' > /etc/gitops-unmanaged.conf"
```

作成したファイルの内容を確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/gitops-unmanaged.conf"
```

**▼ 実行結果**

```plaintext
manual_setting=added
```

この状態で、先ほどと同じ順に確認します。

**実行コマンド**

```plaintext
git status
```

**▼ 実行結果**

```plaintext
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
```

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml --check --diff
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] ********************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]

TASK [疎通確認] *****************************************************************************************************************************************************************************
ok: [target-node2]
ok: [target-node3]
ok: [target-node1]

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

```
【Playbookが管理していないファイルの手動変更】
Git　　　　→ 検出しない（nothing to commit, working tree clean）
Terraform　→ 検出しない（No changes）
Ansible　　→ 検出しない（3台ともchanged=0）
```

今度は、Ansibleも検出しませんでした。`/etc/gitops-unmanaged.conf`は、Playbookのどのタスクにも書かれていないため、`--check`の比較対象に含まれません。ドリフトシリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-drift/ansible-drift-03/)** では、タスクに一切登場しないファイルは、cronジョブで書き換えられても通常実行で検出されないことを確認しました。今回の結果は、同じ構造が`--check`でも成り立ち、GitとTerraformを加えても変わらないことを示しています。

GitにもtfstateにもPlaybookにも記述されていないものは、どのツールからも見えません。「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけです。この範囲の外にある変化をどう減らすかは、第4部の **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。

### ③ 収束処理が走らない期間の放置

3つ目の経路は、実機ではなく構造として整理します。

最初の検証で、Ansibleの`--check`は手動変更を検出し、本実行で収束させられることを確認しました。ただし、これはコマンドを実行したから検出できたのであり、実行しなければ、手動変更はそのまま残り続けます。**[セクション5](#5-push型とpull型本シリーズの立ち位置)** で整理したとおり、push型の構成では、CIは実行が終わると観測を止めます。

```
ずれが発生する
　↓
（次の検知処理が走るまで、誰も観測していない）
　↓
検知処理が走り、ずれを検出する
　↓
収束処理が走り、あるべき状態に戻る
```

Ansible×Terraformシリーズの **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で作った定期検知は、1時間ごとに`ansible-playbook --check`を実行する構成でした。定期実行にしても、実行と実行の間には、ずれが観測されない期間が残ります。また、定期実行そのものが止まっていれば、この期間は際限なく延びます。経路③は、検出できるずれであっても、検出と収束の処理が走らない間はGitと実際の状態が食い違ったままになる、という経路です。

次のセクションでは、この3つの経路が、本シリーズのどの部で扱われるのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. 3つの経路とシリーズ構成の対応

**[セクション6](#6-唯一の真実が崩れる3つの経路)** で整理した3つの経路が、本シリーズのどの部で扱われるのかを示します。

本シリーズは、3つの経路に対して、「経路を塞ぐ」ことと、「塞ぎきれない部分を検知して戻す」ことの2つの方向で対策を積み上げていきます。あわせて、GitOpsの「あるべき状態をすべてGitに置く」という考え方とぶつかる機密情報を、別の課題として扱います。

|経路・課題|対策の方向|扱う部|
|---|---|---|
|① Gitを経由しない手動変更|変更の経路をGitに限定し、Gitを通った変更だけが適用される仕組みを作る|第2部（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** 〜 **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**）|
|Gitに置けない機密情報|Gitの外に置くしかない情報を、パイプラインの中で安全に扱う|第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）|
|② tfstateの観測範囲外で起きる変化、③ 収束処理が走らない期間の放置|定期的な検知と自動収束で、ずれを見つけて戻す。検知できない範囲そのものも狭める|第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）|

経路①に対しては、第2部で、変更がGitを通って初めてインフラに届くパイプラインを作ります。プルリクエストで確認し、マージで適用する基本の流れ（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）に、planのレビューと承認ゲート（**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**）、AnsibleとTerraformの両側に置くガードレール（**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** 、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**）を加えていきます。ただし、パイプラインを整えても、管理対象に直接入って変更する操作そのものを、パイプラインだけで止めることはできません。経路①は、第2部で減らせても、なくすことはできません。残った手動変更は、第4部の検知と収束で扱います。

機密情報は、3つの経路とは性質の異なる課題です。パスワードや鍵はGitに置けないため、インフラのあるべき状態の一部は、最初からGitの外に置くことになります。第3部では、この「Gitの外に置くしかないもの」を、パイプラインの中でどこに置き、どう渡し、漏洩や破損にどう備えるかを設計します。

経路②・③に対しては、第4部で、ずれを見つけて戻す仕組みを作ります。まず、Gitのmainブランチ、実際にインフラへ反映した最後のコミット、実際の状態という3つを区別します（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**）。そのうえで、定期検知（**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)**）と自動収束（**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-19/)**）を作ります。さらに、障害対応でやむを得ず加える手動変更との両立を扱います（**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)**）。**[セクション6](#6-唯一の真実が崩れる3つの経路)** の補足確認で見た「どのツールからも見えない変化」は、検知と収束では扱えません。これは、管理対象の範囲そのものを広げる設計として、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** で扱います。

これらの前提として、第1部の残りの回で土台を整えます。AnsibleとTerraformの責務分担をGitOpsの文脈で引き直し（**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**）、Gitリポジトリの構造を設計し（**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**）、パイプラインを実行する基盤を選びます（**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**）。

次のセクションでは、ここまでの構造が、Dockerプロバイダー以外でも同じように成り立つ理由を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 8. Dockerプロバイダー以外でも同じ構造になる理由

**[セクション6](#6-唯一の真実が崩れる3つの経路)** で確認した結果が、Dockerプロバイダーに固有のものではないことを、構成のどこが置き換わり、どこが置き換わらないかに分けて整理します。

### 置き換わる部分：プロバイダーブロックとリソース定義

本シリーズの検証環境で、Terraformがプロバイダーとコンテナを定義している部分は次のとおりです。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}
provider "docker" {}
```

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = docker_image.ansible_target.image_id
  dynamic "networks_advanced" {
    for_each = local.target_node_networks[each.key]
    content {
      name = networks_advanced.value
    }
  }
  ports {
    internal = 22
    external = each.value
  }
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
  }
  upload {
    file    = "/etc/init_marker"
    content = "init_version=v1\n"
  }
  lifecycle {
    ignore_changes = [network_mode]
  }
}
```

クラウドのプロバイダーに移すときに書き換わるのは、この2つの部分です。対応関係を整理すると、次のとおりです。

|要素|Docker（本シリーズの検証環境）|AWS|GCP|
|---|---|---|---|
|プロバイダー|`kreuzwerker/docker`|`hashicorp/aws`|`hashicorp/google`|
|管理対象のリソース|`docker_container`|`aws_instance`|`google_compute_instance`|
|起動に使うイメージ|`image`（Dockerイメージ）|`ami`|`boot_disk`の`image`|
|接続するネットワーク|`networks_advanced`|`subnet_id`、`vpc_security_group_ids`|`network_interface`|
|SSHの公開鍵の配置|`upload`|`key_name`または`user_data`|`metadata`の`ssh-keys`|

書き換わるのは、どのサービスの、どのリソースを、どの属性で作るかという記述です。Terraformの側では、プロバイダーブロックとリソース定義を差し替えれば、同じ構成をクラウド上に作れます。

### 置き換わらない部分：観測範囲の構造

一方、**[セクション6](#6-唯一の真実が崩れる3つの経路)** の結果を決めていたのは、次の3つの構造でした。

```
Git　　　　→ リポジトリの中のコードの変更だけを記録する
Terraform　→ tfstateに記録したリソースの属性だけを比較する
Ansible　　→ 管理対象に接続し、タスクに書かれた項目だけを比較する
```

この3つは、プロバイダーを差し替えても変わりません。AWSの`aws_instance`でも、GCPの`google_compute_instance`でも、tfstateに記録されるのは、イメージ、インスタンスタイプ、ネットワークといったインスタンスの属性です。インスタンスの中のOSにあるファイルやパッケージの状態は、tfstateに記録されません。Ansibleは、コンテナの代わりに仮想マシンへSSHで接続し、同じようにタスクごとに比較します。

そのため、3つの経路もそのまま当てはまります。

* ① Gitを経由しない手動変更：`docker exec`で入る代わりに、SSHで仮想マシンにログインして設定ファイルを書き換えれば、同じ手動変更になる
* ② tfstateの観測範囲外で起きる変化：仮想マシンの中のファイルの変更は、`terraform plan`では検出されない
* ③ 収束処理が走らない期間の放置：クラウドであっても、検知と収束の処理が走らない間は、ずれは残り続ける

ただし、クラウドの管理コンソールなどからインスタンスの属性そのもの（インスタンスタイプやタグなど）を変更した場合は、tfstateの観測範囲の中の変化になるため、`terraform plan`で差分として検出されます。Ansible×Terraformシリーズの **[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で、コンテナの`restart`属性の変更が検出されたのと同じ構造です。検出できるかどうかを分けるのは、プロバイダーの種類ではなく、変更がリソースの属性の範囲にあるか、OSの中にあるかです。

Terraformがインスタンスの属性を管理し、AnsibleがOSの中を設定するという役割分担である限り、プロバイダーがDocker、AWS、GCPのどれであっても、「Gitが唯一の真実」が崩れる構造は同じです。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* GitOpsの4原則（宣言型、バージョン管理と不変性、自動的な取得、継続的な収束）は、あるべき状態をどう書いて保存するか（原則1・2）と、それをどう実際の状態に反映し続けるか（原則3・4）に分けられ、「Gitが唯一の真実」と言えるかどうかは原則3・4で決まる
* Terraformは宣言型で、tfstateを基準に差分を計算できるが、対象はリソースの属性に限られ、tfstateはGitの外にある。単体では原則3・4を満たさない
* Ansibleは手続き型で、宣言的に振る舞うかどうかはPlaybookの設計で決まる。実行のたびに管理対象へ接続して比較するが、単体では原則3・4を満たさない
* pull型は原則3・4をエージェントの仕組みに組み込んでいるのに対し、本シリーズのpush型の構成では、原則3は目的を代わりに満たし、原則4は定期的な検知と収束を自前で作って近づける
* Playbookが管理しているファイルへの手動変更は、Gitにもtfstateにも現れず、Ansibleの`--check`だけが検出できることを実機で確認した
* Playbookが管理していないファイルへの手動変更は、Git、Terraform、Ansibleのいずれも検出しないことを実機で確認した
* 「唯一の真実」が崩れる3つの経路のうち、Gitを経由しない手動変更は第2部で、tfstateの観測範囲外の変化と収束処理が走らない期間は第4部で扱い、Gitに置けない機密情報は第3部で扱う
* この構造はDockerプロバイダーに固有のものではなく、Terraformがインスタンスの属性を管理し、AnsibleがOSの中を設定する限り、AWSやGCPでも同じである

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

Ansible×Terraformシリーズでは、GitHub Actionsによるドリフトの検知と自動収束までを自動化したうえで、**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)** ・**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で、AnsibleとTerraformがそれぞれ自分の管理範囲しか見ていないというギャップが残ることを確認しました。第1回となる今回は、本シリーズの起点として、GitOpsの4原則を評価軸に、AnsibleとTerraformがそれぞれどの原則を満たし、どの原則を満たさないのかを整理しました。そのうえで、push型の構成という本シリーズの立ち位置を示し、「Gitが唯一の真実」が崩れる3つの経路を整理しました。3つのうち、Gitを経由しない手動変更とtfstateの観測範囲外の変化の2つは、実機で確認しました。最後に、3つの経路と本シリーズの各部の対応を示しました。

次回は、AnsibleとTerraformの責務分担を、GitOpsの文脈で捉え直します。責務分担を「変更の種類ごとに必要な実行」として整理し、変更の3分類、境界が曖昧な設定の判定基準、Gitの外にある接続面を扱います。

**[次回：第2回：AnsibleとTerraformのGitOps上での責務分担](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第50回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)　｜　[次の記事：【GitOps編】第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 11. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第1部：GitOpsの基本概念とAnsibleとの接続

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**|なぜ「Gitがインフラの唯一の真実」なのか|GitOpsの4原則を評価軸として、AnsibleとTerraformの充足度を整理する。push型構成の立ち位置と、「唯一の真実」が崩れる3つの経路を示す。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**|AnsibleとTerraformのGitOps上での責務分担|責務分担を「変更の種類ごとに必要な実行」として捉え直す。変更の3分類、境界が曖昧な設定の判定基準、Gitの外にある接続面を整理する。|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**|GitリポジトリとAnsibleの構造設計|変更の分類をパスで表現するディレクトリ構成、Gitに置くもの・置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を設計する。無料プランの非公開リポジトリでは直接プッシュを防げないため、強制する場所を適用前に移す方針を示す。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**|ローカルGitea vs GitHub Actionsの選択基準|到達性・状態の永続性・機密情報の置き場所・運用負荷の4基準で比較し、選択が信頼境界の要件で決まることを示す。本シリーズはGitHub＋self-hostedランナーを採用し、リポジトリを非公開で運用する。第1部の最終回。|

---

[↑ 目次に戻る](#-目次)

---