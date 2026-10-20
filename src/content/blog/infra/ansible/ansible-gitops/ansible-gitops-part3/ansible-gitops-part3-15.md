---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第15回：Ansible VaultとGitHub Secretsの役割分担'
description: 'Ansible VaultとGitHub Secretsのどちらでも管理できてしまう秘密に、「その秘密が何と一緒に変わるか」というライフサイクルを基準に境界線を引き、「Gitの中はVault、Gitの外は鍵」の役割分担を確定させる。基準に合わない置き方の帰結を今のパイプラインの実例から整理し、Terraformを経由していたユーザーのパスワードと接続用の鍵を、tfstateに秘密が残らない形に移す。Secretsを環境ごとに分けても残る限界と、長期間有効な鍵を外部に預けないOIDCの考え方も示す。'
pubDate: 2026-10-20
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'Ansible Vault', 'GitHub Secrets']
seriesId: 'ansible-gitops-part3'
seriesNo: 15
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第3部まとめブログ：機密情報は「どこに置くか」だけでなく「どこに残るか」で設計する** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [秘密が何と一緒に変わるかで境界線を引く](#2-秘密が何と一緒に変わるかで境界線を引く)
3. [基準に合わない置き方は何を起こすか](#3-基準に合わない置き方は何を起こすか)
4. [tfstateに秘密を残さない](#4-tfstateに秘密を残さない)
5. [Secretsを環境ごとに分けても残る限界](#5-secretsを環境ごとに分けても残る限界)
6. [長期間有効な鍵を預けないOIDC](#6-長期間有効な鍵を預けないoidc)
7. [クラウドのシークレット管理サービスを加えても構造は同じ](#7-クラウドのシークレット管理サービスを加えても構造は同じ)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインで、機密情報を扱っていて、

* 機密情報は、Ansible VaultかGitHubのSecretsのどちらかに入れている
* どちらも、値を暗号化して守ってくれる
* よって、どの秘密をどちらに置くかは、扱いやすいほうで決めてよい

と考えていないでしょうか。

Ansible VaultとGitHubのSecretsを扱う記事の多くは、それぞれの使い方を個別に説明しています。どちらでも秘密の値を扱えるときに、どの秘密をどちらに置くかを何で決めるかや、その判断がTerraformのtfstateまで含めてどう影響するかは、あまり扱われていません。TerraformとAnsibleのパイプラインで2つを併用し始めると、次のような場面にぶつかります。

* 同じパスワードが、GitHubのSecretsと手元の変数ファイルの両方にあり、片方だけが古いままだった
* Secretsで渡していたパスワードを変えたが、いつ、誰が、何に変えたのかを、後から追えなかった
* どの秘密をAnsible Vaultに、どの秘密をGitHubのSecretsに置くかが決められず、置き場所が人によって違っていた
* Terraformの変数に`sensitive`を付けたのに、tfstateに値がそのまま残っていた

これらは、ツールの使い方や、運用の手順の問題に見えます。共通しているのは、秘密の置き場所を、ツールの機能や安全性から選んでいて、その秘密が何と一緒に、いつ変わるのかで決めていない点です。

機密情報の置き場所は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、Terraformの変数に`sensitive = true`を指定しても、値はtfstateに平文のまま残ることを確かめたうえで、インフラを作るための鍵はTerraform側、インフラの中身に設定する鍵はAnsible Vault側という役割分担を整理しました。判断の基準は、その機密情報が主にどちらのツールの実行に必要とされるかでした。同じ回では、Ansible Vaultをパスワード管理ツールの代わりに使う誤用を挙げ、Ansible Vaultは暗号化の手段であって、誰が発行し、誰が使い、いつ失効させるかという機密情報のライフサイクルを管理する仕組みではないと整理しています。これらは、手元からTerraformとAnsibleを実行する構成での整理で、GitHubのSecretsという、Gitの外にあるもう1つの置き場所は扱っていません。

本シリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3では、Gitに置くかどうかを、中身が「決めたこと」か「実行の結果」かで分け、決めたことであっても、パスワードのような秘密の値はGitに置かないとしました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6では、GitHubとself-hostedランナーの構成を、コード、Secrets、ジョブのログをGitHubに預ける線の引き方として整理し、長期間有効なクラウドの認証情報をSecretsに置かずに済ませるような、外部に預ける範囲を狭める設計を、第3部（第13回〜第16回）で扱うとしました。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション4では、操作する人の鍵が、dev・stg・prodのすべてのコンテナに入っていることを確かめ、どの鍵を、どこに置き、誰に持たせるかを第3部に送っています。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、第2部（第5回〜第12回）で暫定のまま残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値の2種類に分けて棚卸しし、1つの値がGitの外の複数の場所にあることと、値が使う場所より広く渡っていることを確かめました。また、Gitに置かなかった値も、tfstate、保存したplan、イメージの履歴に残ることを確かめ、機密情報を平文でGitに置かない方法を、「Gitに置かない」と「Gitに置くが読めなくする」の2つに整理しました。どちらを選ぶかの手がかりは2種類の分類にあるとし、判断の基準と機密情報ごとの役割分担は、この回で確定させるとしています。

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** では、「Gitに置くが読めなくする」選択肢として、Ansible VaultをGitOpsのパイプラインに組み込みました。暗号化した値はVaultパスワードに集まり、そのVaultパスワードをGitHubのSecretsに置くことで、暗号文と復号の鍵が同じGitHubの上にそろうことを確かめています。また、Vaultパスワードを環境ごとに分けて渡すため、Environmentのシークレットとブランチの規則を確かめ、この検証環境では効いたものの、mainへの直接プッシュや、同じホストで動くself-hostedランナーという限界が残ることを示しました。同じ回の対象は、操作対象に入れる秘密の値のうち、Ansibleだけが使う値でした。コンテナのユーザーのパスワードのように、Terraformを経由して渡している値は、今もSecretsからTerraformの変数として渡り、tfstateとイメージの履歴に残ったままです。

第15回となる今回は、これまでの回で送ってきた、機密情報の置き場所の判断をまとめます。まず、「その秘密が何と一緒に変わるか」を基準に、Ansible VaultとGitHub Secretsの役割分担を、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** の棚卸しの表に置き場所を加える形で確定させます。次に、基準に合わない置き方をすると何が起きるかを、今のパイプラインの中にある実例から整理します。そのうえで、Terraformを経由して渡しているユーザーのパスワードをAnsible Vaultに移し、Terraformが作っていた接続用の鍵を、外部で作った鍵の公開鍵だけを渡す形に変えて、tfstateに秘密が残らなくなることを実機で確かめます。さらに、Secretsを環境ごとに分けても残る限界と、そのときにどこを信頼するかの選択肢、長期間有効な鍵を外部に預けないOIDCの考え方を整理し、クラウドのシークレット管理サービスを加えても、この構造が変わらないことを示します。

正確に言うと、**Ansible VaultとGitHub Secretsのどちらに置くかは、どちらが安全かでは決まりません。その秘密が、Playbookのコードと一緒に変わるのか、パイプラインの実行環境と一緒に変わるのかで決まります**。この回で扱う問いは、「どちらでも管理できてしまうAnsible VaultとGitHub Secretsに、何を基準に境界線を引き、その境界線を、Terraformの側の秘密まで含めて、どう通せばよいのか」です。

次のセクションでは、「その秘密が何と一緒に変わるか」という基準で、境界線を引きます。

---

[↑ 目次に戻る](#-目次)

---

## 2. 秘密が何と一緒に変わるかで境界線を引く

機密情報ごとに、その値が何と一緒に変わるかを見て、Ansible VaultとGitHub Secretsの境界線を引きます。

### 2種類の秘密は、変わるきっかけが違う

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値の2種類に分けました。2種類は、使い道だけでなく、値が変わるきっかけも違います。

操作対象に入れる秘密の値は、操作対象の設定の一部です。

* アプリケーションのパスワードを変えるのは、そのパスワードを使う設定ファイルやユーザーの設定を変えるときで、Playbookのコードの変更と一緒に起きる
* どの値に変えたかは、コードの変更と同じく、レビューし、履歴に残したい「決めたこと」である

パイプラインがツールを動かすための鍵は、パイプラインの実行環境の一部です。

* tfstateのデータベースへの接続文字列が変わるのは、データベースを作り直したときである
* 接続用の鍵を入れ替えるのは、鍵の有効期間が来たときや、漏れたおそれがあるときである

どちらも、Playbookのコードとは関係なく変わります。また、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション6で整理したとおり、これらの鍵は、パイプラインがリポジトリを取得し、ツールを動かし始めるときに、すでに必要なものです。

|分類|何と一緒に変わるか|置き場所|
|---|---|---|
|操作対象に入れる秘密の値|Playbookのコード（操作対象の設定）|Gitの中。Ansible Vaultで暗号化し、コードと同じくレビューと履歴の対象にする|
|ツールを動かすための鍵|パイプラインの実行環境（ランナー、バックエンド、鍵の入れ替え）|Gitの外。GitHubのSecretsと、人の手元に置く|

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3では、Gitに置くかどうかを、中身が「決めたこと」か「実行の結果」かで分けました。操作対象に入れる秘密の値は、決めたことです。それでもGitに置けなかったのは、平文では置けないためでした。Ansible Vaultで値を暗号化すれば、決めたことを、決めたこととしてGitに戻せます。一方、ツールを動かすための鍵は、あるべき状態そのものではなく、あるべき状態を操作対象に届けるための手段です。Gitの仕組みの中に置く理由がありません。

### どちらのツールが使うかでは、境界線が引けない

**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、その機密情報が主にどちらのツールの実行に必要とされるかを基準に、インフラを作るための鍵はTerraform側、インフラの中身に設定する鍵はAnsible Vault側としました。この基準は、TerraformとAnsibleのどちらに持たせるかを決めるものです。

ところが、どちらのツールが使うかは、今の実装で決まっているにすぎません。この検証環境では、コンテナの`ansible`ユーザーのパスワードは、Terraformの変数としてイメージのビルドに渡り、イメージの中で設定されています（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4）。今の実装だけを見れば、このパスワードはTerraformの実行に必要な値です。どちらのツールが使うかで置き場所を決めると、実装のままGitHubのSecretsに置くことになります。

何と一緒に変わるかで見ると、このパスワードは、操作対象のユーザーの設定と一緒に変わる値です。置き場所はGitの中で、Ansible Vaultで暗号化して置くことになります。そうすると、渡し方も、Terraformの変数ではなく、Ansibleが操作対象のユーザーに設定する形に変えることになります。ライフサイクルで置き場所を決めると、どちらのツールに持たせるかも、それに合わせて決まります。

### SecretsがVaultの鍵を持つ2層の構造

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション2で確かめたとおり、Ansible Vaultで暗号化した値は、Vaultパスワード1つの後ろに集まります。このVaultパスワードは、Playbookのコードとは関係なく変わる、ツールを動かすための鍵です。そのため、Gitの外のGitHubのSecretsと、値を暗号化する人の手元に置きます。

```
Gitの中
　└─ 操作対象に入れる秘密の値（Ansible Vaultの暗号文）
　　　　　↑ 復号する
Gitの外
　├─ Vaultパスワード（GitHubのSecrets、人の手元）
　└─ そのほかのツールを動かすための鍵（GitHubのSecrets、人の手元）
```

「Gitの中はVault、Gitの外は鍵」という役割分担は、2つの置き場所を並べるのではなく、Secretsが、Vaultを開く鍵を持つ2層の構造になります。Gitの中の秘密がいくつ増えても、Gitの外で守るのはVaultパスワードです。

ただし、この構造は、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション2で見た「暗号文と復号の鍵が、同じGitHubの上にそろう」状態を変えません。リポジトリとSecretsの両方に入れる人には、どちらの層の秘密も読めます。外部に預ける範囲をどこまで狭められるかは、**[セクション5](#5-secretsを環境ごとに分けても残る限界)** から **[セクション7](#7-クラウドのシークレット管理サービスを加えても構造は同じ)** で扱います。

### 機密情報ごとの置き場所

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4の棚卸しに、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で加わったVaultパスワードを足し、この回で決める置き場所を並べます。「今の置き場所」は、値そのものがある場所です。

ツールを動かすための鍵は、次のとおりです。

|機密情報|何と一緒に変わるか|今の置き場所|この回で決める置き場所|
|---|---|---|---|
|接続用の秘密鍵|鍵の入れ替え、環境の作り直し|各環境のtfstate、手元の`ansible/keys/<環境>/`|GitHubのSecrets（環境ごと）と手元。外部で作り、Terraformには公開鍵だけを渡す|
|操作する人の鍵|操作する人|手元の`~/.ssh/id_ed25519`|手元（変えない）|
|接続文字列|tfstateのデータベース|GitHubのSecrets、手元の`backend.env`|GitHubのSecretsと手元（変えない）|
|Vaultパスワード|Vaultパスワードの入れ替え|GitHubのSecrets、手元の`~/.config/ansible-vault/`|GitHubのSecretsと手元（変えない）|

操作対象に入れる秘密の値は、次のとおりです。

|機密情報|何と一緒に変わるか|今の置き場所|この回で決める置き場所|
|---|---|---|---|
|`ansible`のパスワード|操作対象のユーザーの設定|GitHubのSecrets、手元の3環境の`terraform.tfvars`。tfstateとイメージの履歴にも残っている|Gitの中。環境ごとの`group_vars`に、Ansible Vaultで値ごとに暗号化して置き、Ansibleが設定する|
|`deploy`のパスワード|どのコンテナも使っていないイメージのユーザーの設定|GitHubのSecrets、手元のprodの`terraform.tfvars`|この回では移さない|

接続用の秘密鍵は、ツールを動かすための鍵なので、置き場所はGitの外のままです。変えるのは、Terraformが鍵を作り、tfstateに秘密鍵を記録している点です。秘密鍵は外部で作ってGitHubのSecretsに置き、Terraformには公開鍵だけを渡します。公開鍵は秘密ではないため、Gitに置きます。鍵を入れ替えるときは、Secretsの秘密鍵と、Gitの公開鍵の両方を入れ替えることになります。

`ansible`のパスワードを、Terraformの変数からAnsible Vaultに移す作業と、接続用の鍵を作る場所を変える作業は、どちらもtfstateから秘密をなくすための変更です。この2つは、**[セクション4](#4-tfstateに秘密を残さない)** で、実機で行います。

表の中で、この回では移さないものが2つあります。

* `deploy`のパスワードは、prodの、どのコンテナも使っていない2つのイメージのビルドに渡っているだけです。管理していないものの整理は、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** の主題のため、この回では移しません
* 操作する人の鍵は、1つの鍵で3つの環境のすべてのコンテナに入れます（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション4）。置き場所は手元で変わりませんが、環境の境界がないことは、**[セクション5](#5-secretsを環境ごとに分けても残る限界)** で、Secretsを環境ごとに分けても残る限界の1つとして扱います

この検証環境にはない、クラウドの認証情報も、ツールを動かすための鍵に当たります。長期間有効な認証情報をSecretsに置かずに済ませる方法は、**[セクション6](#6-長期間有効な鍵を預けないoidc)** で扱います。

次のセクションでは、この基準に合わない置き方をすると何が起きるかを、今のパイプラインの中にある実例から整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 基準に合わない置き方は何を起こすか

**[セクション2](#2-秘密が何と一緒に変わるかで境界線を引く)** の基準に合わない置き方を3つ取り上げ、それぞれで何が起きるかを、今のパイプラインの実例と、これまでの回の結果から整理します。

### 置き方1：操作対象に入れる値を、Secretsで渡す

今のパイプラインでは、`ansible`ユーザーのパスワードが、この置き方になっています。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4で確かめたとおり、値はGitHubのSecretsから`TF_VAR_`の環境変数としてジョブに渡り、Terraformの変数を通って、イメージのビルドの`build_args`に渡っています。

操作対象の設定と一緒に変わる値を、Gitの外に置いているため、次のことが起きます。

* 値を変えても、Gitにコミットは残らない。Secretsの画面で分かるのは、名前と、おおよその更新時期だけで、誰が、どの値に変えたかは表示されなかった（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4）
* 値の変更は、プルリクエストのレビューも、承認ゲートの入口の確認も通らない
* Terraformに渡した値は、イメージのリソースの属性としてtfstateに残り、ビルドしたイメージの履歴にも残る（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション5）
* イメージには`ignore_changes = [build]`を付けているため（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション3）、Secretsの値を変えても、イメージは作り直されない。Secretsの値と、コンテナの中のパスワードが食い違ったまま、誰も気づかないことになる（この点は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の設定からの導出で、実機では確かめていません）

値を変えたことがGitに残らず、変えた値が操作対象に届いたかも、パイプラインからは分かりません。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション2で整理した「Gitの外に置いた値は、Gitの仕組みの外にある」状態が、操作対象の設定の一部で起きていることになります。

### 置き方2：接続用の秘密鍵を、Vaultで暗号化してGitに置く

今のパイプラインには、この置き方はありません。ただ、接続用の鍵をtfstateから外そうとすると、選びたくなる置き方です。Vaultで暗号化すれば、鍵もGitで管理でき、ほかの秘密と同じ仕組みで扱えるように見えるためです。

接続用の秘密鍵は、パイプラインの実行環境と一緒に変わる、ツールを動かすための鍵です。これをGitの中に置くと、次のことが起きます。

* 鍵を入れ替えるたびに、暗号文を書き換えるコミットが必要になる。入れ替えのきっかけ（有効期間、漏れたおそれ）は、Playbookのコードの変更とは関係がない
* 古い鍵の暗号文も、Gitの履歴に残る。Vaultパスワードが漏れれば、履歴に残った過去の鍵も、すべての複製で読めることになる（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション6の導出と同じ構造）
* SSHの接続に使うには、ジョブの中で復号した鍵をファイルに書き出す必要がある。書き出したファイルは、置き場所とジョブの終わり方しだいで、ランナーのホストに残る（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション3）
* Vaultパスワード1つの後ろに、操作対象に入れる値だけでなく、操作対象に入るための鍵までが集まる

Gitの中に置いても、鍵の入れ替えは、レビューする価値のある「決めたこと」にはなりません。履歴に残るのは、残す必要のない過去の鍵です。

### 置き方3：同じ秘密を、複数の場所に置く

今のパイプラインでは、`ansible`ユーザーのパスワードが、GitHubのSecretsと、手元の3環境の`terraform.tfvars`の4か所にあります（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4）。パイプラインはSecretsの値を使い、手元からの`terraform`の実行は変数ファイルの値を使います。

同じ秘密が複数の場所にあると、次のことが起きます。

* どの場所の値が正しいかが、Gitを見ても分からない。Secretsの値は読み出せないため、手元の値と同じかどうかも確かめられない
* 値を入れ替えるときに、すべての場所を入れ替える必要があり、1か所でも漏れれば、実行する場所によって違う値が使われる
* 置き方1から、この回のように値をAnsible Vaultに移すと、元のSecretsと変数ファイルを消さない限り、Gitの中にも外にも同じ秘密がある状態になる

ただし、置き場所が複数あること自体が問題なのではありません。Vaultパスワードも、GitHubのSecretsと手元の2か所にあります（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション2）。ジョブが復号するためにも、人が暗号化するためにも必要で、2か所は同じきっかけで、一緒に入れ替えるものです。

違いは、どの値が正しいかが1つに決まっているかです。Vaultパスワードは、2か所のどちらも同じ1つの値の写しで、片方だけを変える理由がありません。`ansible`ユーザーのパスワードは、Secretsはパイプラインのため、変数ファイルは手元からの実行のためという別々の理由で置かれ、それぞれが別々に変えられる状態です。

### 3つの置き方のまとめ

|置き方|起きること|
|---|---|
|操作対象に入れる値を、Secretsで渡す|値の変更がGitに残らず、レビューも承認も通らない。渡し方しだいで、tfstateとイメージの履歴に残る|
|接続用の秘密鍵を、Vaultで暗号化してGitに置く|入れ替えのたびにコミットが要り、過去の鍵が履歴に残る。復号した鍵がランナーに書き出される|
|同じ秘密を、複数の場所に置く|どの値が正しいかが決まらず、入れ替えの漏れが起きる|

**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で挙げた誤用（パスワード管理ツールの代わりに使う、Vaultパスワードを平文で共有する、暗号化の粒度が粗い）は、Ansible Vaultの使い方の誤りでした。ここで挙げた3つは、Ansible VaultとGitHub Secretsのどちらに置くかの誤りで、どれも、秘密が何と一緒に変わるかと、置き場所が合っていないことから起きています。

### 移すときは、元の置き場所をなくすまでが移行

置き方3から分かるとおり、秘密を正しい置き場所に移しても、元の置き場所が残っていれば、同じ秘密が複数の場所にある状態になります。`ansible`ユーザーのパスワードをAnsible Vaultに移すときは、次のものもなくす必要があります。

* GitHubのSecretsの`TF_VAR_ANSIBLE_USER_PASSWORD`
* 手元の3環境の`terraform.tfvars`の`ansible_user_password`
* tfstateの、イメージのリソースの`build_args`に記録された値
* ビルドしたイメージの履歴に残った値

このうち、tfstateとイメージの履歴に残った値は、コードからパスワードを外しても、それだけでは消えません。次のセクションでは、この移行を、接続用の鍵の作り方の変更とあわせて、実機で行います。

---

[↑ 目次に戻る](#-目次)

---

## 4. tfstateに秘密を残さない

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で確かめた、tfstateに残る2つの秘密を、**[セクション2](#2-秘密が何と一緒に変わるかで境界線を引く)** で決めた置き場所に移し、tfstateとイメージの履歴から消えたかを実機で確かめます。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション5では、tfstateに次の2つが残っていました。

* 接続用の秘密鍵：Terraformの`tls_private_key`が作り、属性`private_key_openssh`と出力`generated_private_key`の2か所に記録されていた
* `ansible`のパスワード：Terraformの変数としてイメージのビルドに渡り、`build_args`に記録されていた

どちらも、Terraformが秘密の値を「作る」か「受け取る」ことで、tfstateに入っていました。

### Terraformに値を残させない仕組みは使えるか

Terraformには、値をtfstateに記録しない仕組みとして、ephemeralな値と、書き込み専用の属性があります。ephemeralなリソースは実行のたびに値を作り、tfstateにもplanにも記録しません。書き込み専用の属性は、リソースに値を渡しても、その値をtfstateに残しません。ただし、どちらもプロバイダーの側が対応している必要があります。

### ■ 検証内容：使っているプロバイダーが、値を残さない仕組みに対応しているか

この検証環境のTerraformと、使っている2つのプロバイダーのバージョンです。

```plaintext
Terraform v1.15.7
hashicorp/tls 4.3.0
kreuzwerker/docker 3.0.2
```

プロバイダーのスキーマから、ephemeralなリソースと、書き込み専用の属性を探します。

**実行コマンド**

```plaintext
terraform providers schema -json > /tmp/gitops15-schema.json
echo "== tls ephemeral resources"
jq -r '.provider_schemas["registry.terraform.io/hashicorp/tls"].ephemeral_resource_schemas // {} | keys[]' /tmp/gitops15-schema.json
echo "== docker ephemeral resources"
jq -r '.provider_schemas["registry.terraform.io/kreuzwerker/docker"].ephemeral_resource_schemas // {} | keys[]' /tmp/gitops15-schema.json
echo "== write_only attributes"
jq -r 'paths(type == "object" and .write_only == true) | map(tostring) | join(".")' /tmp/gitops15-schema.json; echo "jq_exit_code=$?"
```

**▼ 実行結果**

```plaintext
== tls ephemeral resources
tls_private_key
tls_public_key
== docker ephemeral resources
== write_only attributes
jq_exit_code=0
```

`hashicorp/tls`には、ephemeralな`tls_private_key`があります。一方、`kreuzwerker/docker`にはephemeralなリソースがなく、2つのプロバイダーのどちらにも、書き込み専用の属性は1つもありませんでした。

鍵をephemeralに作れても、それを受け取るのは、dockerプロバイダーの`docker_container`の`upload`の`content`です。ephemeralな値を、書き込み専用ではない属性に渡すとどうなるかを、リポジトリの外の一時ディレクトリで確かめます。dockerのリソースは使わず、Terraformに組み込みの`terraform_data`に、ephemeralな鍵の公開鍵を渡します。

* **ファイル名：`main.tf`**（一時ディレクトリ）

```hcl
terraform {
  required_providers {
    tls = {
      source  = "hashicorp/tls"
      version = "4.3.0"
    }
  }
}

ephemeral "tls_private_key" "generated" {
  algorithm = "ED25519"
}

resource "terraform_data" "authorized_key" {
  input = ephemeral.tls_private_key.generated.public_key_openssh
}
```

**実行コマンド**

```plaintext
terraform plan -input=false -no-color; echo "plan_exit_code=$?"
```

**▼ 実行結果**

```plaintext
Error: Invalid use of ephemeral value

  with terraform_data.authorized_key,
  on main.tf line 15, in resource "terraform_data" "authorized_key":
  15:   input = ephemeral.tls_private_key.generated.public_key_openssh

Ephemeral values are not valid for "input", because it is not a write-only attribute and must be persisted to state.
plan_exit_code=1
```

### ■ 結果

ephemeralな鍵から取り出した値は、秘密ではない公開鍵であってもephemeralな値として扱われ、tfstateに記録される属性には渡せませんでした。`plan`の段階で止まります。また、ephemeralなリソースは実行のたびに値を作り直すため、仮に渡せたとしても、実行のたびに鍵が変わることになります。

つまり、この検証環境のプロバイダーでは、Terraformの中で秘密を作る限り、tfstateに残さない方法はありません。値を残さない仕組みが使えるかどうかは、Terraformのバージョンではなく、使うプロバイダーとリソースで決まります。そこで、この回では、**Terraformで秘密を作らない、Terraformに秘密を渡さない**形に変えます。

### 鍵は外で作り、公開鍵だけをTerraformに渡す

接続用の鍵は、環境ごとにTerraformの外で作ります。秘密鍵は、**[セクション2](#2-秘密が何と一緒に変わるかで境界線を引く)** で決めたとおり、GitHubのSecretsと手元に置きます。

**実行コマンド**

```plaintext
K=~/.config/gitops-keys
mkdir -p -m 700 "$K"
for e in dev stg prod; do mkdir -p -m 700 "$K/$e"; ssh-keygen -q -t ed25519 -N '' -C "gitops-$e-connect" -f "$K/$e/id_ed25519"; done
for e in dev stg prod; do cp "$K/$e/id_ed25519.pub" terraform/envs/$e/connect_key.pub; done
for e in dev stg prod; do echo "== $e"; ssh-keygen -lf terraform/envs/$e/connect_key.pub; done
```

**▼ 実行結果**

```plaintext
== dev
256 SHA256:oJnNtKhFcDjYtAywj85U1wPzdEw5/IEiIgq1VW+cj0U gitops-dev-connect (ED25519)
== stg
256 SHA256:pmIEcnhshITW1oPBZCDJ73AMGhXnPszK6VXpXw/OVjw gitops-stg-connect (ED25519)
== prod
256 SHA256:+h2eH4Wjmm+1j0sccCbo5yBpLAz6Wudg0+W67B8x1wU gitops-prod-connect (ED25519)
```

3つの秘密鍵は、GitHubのSecretsに`CONNECT_PRIVATE_KEY_DEV`・`CONNECT_PRIVATE_KEY_STG`・`CONNECT_PRIVATE_KEY_PROD`として登録しました。公開鍵の`connect_key.pub`は、各環境のディレクトリに置いてGitで管理します。

モジュールからは`tls_private_key`と出力`generated_private_key`を削除し、公開鍵を変数で受け取ります。

* **ファイル名：`terraform/modules/lab_env/main.tf`**（差分から抜粋）

```diff
-resource "tls_private_key" "generated" {
-  algorithm = "ED25519"
-}
-
 resource "docker_container" "targets" {
（途中省略）
   upload {
     file    = "/home/ansible/.ssh/authorized_keys"
-    content = "${var.operator_public_key}\n${tls_private_key.generated.public_key_openssh}"
+    content = "${var.operator_public_key}\n${var.connect_public_key}"
   }
```

* **ファイル名：`terraform/envs/dev/main.tf`**（差分から抜粋。stg・prodも同じ）

```diff
-  ansible_user_password = var.ansible_user_password
-  operator_public_key   = file("${path.module}/../../id_ed25519.pub")
+  connect_public_key  = file("${path.module}/connect_key.pub")
+  operator_public_key = file("${path.module}/../../id_ed25519.pub")
```

この形は、操作する人の公開鍵を渡す`operator_public_key`と同じです。tfstateには公開鍵しか入りません。

### パスワードはAnsible Vaultに移す

`ansible`のパスワードは、イメージのビルドで設定するのをやめ、Ansibleがユーザーに設定する形に変えます。`Dockerfile`からは、パスワードを受け取る`ARG`と、それを設定する`chpasswd`を削除します。

* **ファイル名：`terraform/Dockerfile`**（差分から抜粋）

```diff
 # 検証用ユーザー（ansible）の作成と sudo 権限付与
-ARG ANSIBLE_USER_PASSWORD
 RUN useradd -m -s /bin/bash ansible && \
-    echo "ansible:${ANSIBLE_USER_PASSWORD}" | chpasswd && \
     echo 'ansible ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
```

この検証環境の`ansible`ユーザーは、`sudo`にパスワードを使わず（`NOPASSWD:ALL`）、接続にも鍵を使っています。パスワードの設定をビルドから外しても、接続と権限昇格は変わりません。

新しいパスワードは環境ごとに作り、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で決めた`vault_`で始まる名前で、値ごとに暗号化して`group_vars`に置きます。平文はファイルにも画面にも出さず、作った値をそのまま`encrypt_string`に渡します。

**実行コマンド**

```plaintext
VP=~/.config/ansible-vault/gitops14-vault-pass
for e in dev stg prod; do
  f=ansible/inventories/$e/group_vars/target_nodes.yml
  printf 'common_setup_ansible_user_password: "{{ vault_ansible_user_password }}"\n' >> "$f"
  (P=$(openssl rand -hex 16); printf '%s' "$P" | ansible-vault encrypt_string --vault-password-file "$VP" --stdin-name vault_ansible_user_password >> "$f" 2>/dev/null)
done
```

* **ファイル名：`ansible/inventories/dev/group_vars/target_nodes.yml`**

```yaml
---
common_setup_env: dev
common_setup_ansible_user_password: "{{ vault_ansible_user_password }}"
vault_ansible_user_password: !vault |
          $ANSIBLE_VAULT;1.1;AES256
          32393632343235636462383836666263393431323863373831393038633262623634656431356537
          （途中省略）
```

ロールが使う名前（`common_setup_ansible_user_password`）は平文の行で、暗号化した`vault_ansible_user_password`を参照するだけです。ロールの既定値には置かず、`group_vars`で渡し忘れたときは未定義の変数で止まるようにします。

ロールには、パスワードを設定するタスクを加えます。

* **ファイル名：`ansible/roles/common_setup/tasks/ansible_user.yml`**

```yaml
---
- name: ユーザーansibleのパスワードを設定
  become: true
  no_log: true
  ansible.builtin.user:
    name: ansible
    password: "{{ common_setup_ansible_user_password | password_hash('sha512', (inventory_hostname | hash('sha256'))[:16]) }}"
```

`password_hash`のソルトは、ホストの名前から決まる値にしています。実行のたびにソルトが変わると、ハッシュが毎回変わり、毎回`changed`になって冪等になりません。モジュールの引数に秘密が含まれるため、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション5で決めた使い分けに従って`no_log: true`を付けています。Moleculeのテストは環境の`group_vars`を読まないため、`converge.yml`でテスト用のダミーの値を渡します。

### ■ 検証内容：`no_log: true`のタスクが失敗したときの表示

このタスクを加えた直後、手元から確認モードで実行すると、5台すべてで失敗しました。

**実行コマンド**

```plaintext
for e in dev stg prod; do echo "== $e"; ansible-playbook -i inventories/$e site.yml --check --diff --vault-password-file "$VP" 2>/dev/null | grep -E 'TASK \[common_setup : ansible|censored|: ok='; done
```

**▼ 実行結果**（devから抜粋）

```plaintext
== dev
TASK [common_setup : ansibleユーザーのパスワードを設定] ************************
fatal: [dev-node1]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result"}
dev-node1                  : ok=4    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`no_log: true`を付けたタスクでは、失敗した理由そのものまで隠れました。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で確かめていなかった、失敗したときの表示です。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で行った、止まったタスクのメッセージから原因を読み取る診断が、このタスクではできません。

理由を見るために`no_log`を外すと、本物のパスワードがログに出るおそれがあります。そこで、ダミーの値と固定のソルトで、同じ式だけを手元で試しました。

**実行コマンド**

```plaintext
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ 'gitops15-dummy' | password_hash('sha512', 'abcdefgh12345678') }}"
```

**▼ 実行結果**

```plaintext
localhost | FAILED! => {
    "msg": "Unable to encrypt nor hash, passlib must be installed. No module named 'passlib'. Unable to encrypt nor hash, passlib must be installed. No module named 'passlib'"
}
```

原因は、この検証環境のAnsible（ansible-core 2.17）で`password_hash`を使うには、Pythonの`passlib`が必要だったことでした。また、ansible-lintの`name[casing]`（名前は大文字で始める）に合わせて、タスクの名前を「ansibleユーザーのパスワードを設定」から「ユーザーansibleのパスワードを設定」に変えました。Ansibleの仮想環境に`passlib` 1.7.4を入れると、ansible-lintとMoleculeの`idempotence`を含めて通り、確認モードでは5台とも、パスワードのタスクだけが`changed`になりました。秘密を隠したタスクが失敗したときは、秘密を使わない形で同じ処理を再現して原因を探すことになります。

### ワークフローは、使うステップにだけ渡す

「GitOps Pipeline」と「GitOps Apply」も書き換えます。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** の棚卸しで、ワークフロー全体の`env`で3つのSecretsを渡していた点を、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で決めた「使うステップの`env`だけで渡す」形にそろえます。

* ワークフロー全体の`env`のSecretsをやめ、`PG_CONN_STR`はtfstateを読み書きするステップにだけ渡す
* `TF_VAR_deploy_user_password`は、prodを含む`terraform plan`のステップにだけ渡す。`ansible`のパスワードは、どこにも渡さない
* 接続用の秘密鍵は、tfstateの出力ではなくSecretsから受け取り、`$RUNNER_TEMP`に書き出す
* Vaultパスワードは、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** の渡し方Bのスクリプト（`.github/scripts/vault-pass.sh`）を`--vault-password-file`に渡す

* **ファイル名：`.github/workflows/gitops-apply.yml`**（`ansible-apply`ジョブから抜粋）

```yaml
      - name: Write private key from secrets
        env:
          CONNECT_PRIVATE_KEY: ${{ inputs.environment == 'dev' && secrets.CONNECT_PRIVATE_KEY_DEV || inputs.environment == 'stg' && secrets.CONNECT_PRIVATE_KEY_STG || secrets.CONNECT_PRIVATE_KEY_PROD }}
        run: |
          umask 077
          mkdir -p "$RUNNER_TEMP/keys/$TARGET_ENV"
          printf '%s\n' "$CONNECT_PRIVATE_KEY" > "$RUNNER_TEMP/keys/$TARGET_ENV/id_ed25519"
          ls -l "$RUNNER_TEMP/keys/$TARGET_ENV"
      - name: Ansible playbook
        working-directory: ansible
        env:
          PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
          ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
          GITOPS_KEY_DIR: ${{ runner.temp }}/keys
        run: ansible-playbook -i "inventories/$TARGET_ENV" site.yml --diff --vault-password-file ../.github/scripts/vault-pass.sh
      - name: Remove private key
        if: always()
        run: rm -rf "$RUNNER_TEMP/keys"
```

「GitOps Apply」では、選んだ環境の秘密鍵だけをジョブに渡します。インベントリのスクリプトは、環境変数`GITOPS_KEY_DIR`があればその下の鍵を、なければ手元の`~/.config/gitops-keys/<環境>/`の鍵を、各ホストに渡すように変えました。秘密鍵の書き出し先を`$RUNNER_TEMP`にしたのは、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション3で、ジョブの終わりに空になることを確かめた場所だからです。

ホステッドランナーで動く「Drift Check」と「E2E Provisioning Test」は、tfstateの出力の秘密鍵とTerraformの変数のパスワードを前提にしているため、この変更の後は動きません。ワークフローを無効にし、定期実行で検知する仕組みとあわせて **[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で作り直します。

### 鍵を入れ替えるあいだは、両方の鍵を受け付ける

この変更をプルリクエストにすると、確認の`ansible-check`ジョブは、Secretsの新しい鍵でコンテナに接続します。ところが、新しい公開鍵がコンテナに入るのは、マージの後に適用でコンテナを作り直したときです。このままでは、確認のジョブが接続できずに失敗し、承認待ちも作られません。

鍵を入れ替えるときは、新しい鍵と古い鍵の両方を受け付ける期間が必要です。そこで、移行のための一時的な例外として、今のコンテナの`authorized_keys`に新しい公開鍵を手で書き足しました。書き足した行は、適用でコンテナが作り直されるときに消え、`authorized_keys`は`upload`の内容だけになります。

### ■ 検証内容：プルリクエストからprodまで適用する

プルリクエスト#74で確認し、マージの後、dev→stg→prodの順に「GitOps Apply」で適用します。確認の「GitOps Pipeline」の実行#135では、planに次の変更が現れました。

**▼ 実行結果**（「GitOps Pipeline」の実行#135、`terraform-plan`ジョブのステップ「Terraform plan」のdevから抜粋）

```plaintext
  # module.lab_env.docker_container.targets["dev-node1"] must be replaced
（途中省略）
      - upload { # forces replacement
      + upload { # forces replacement
（途中省略）
      + triggers     = { # forces replacement
          + "secrets_placement" = "gitops15"
        }
（途中省略）
      - build {
          # At least one attribute in this block is (or was) sensitive,
          # so its contents will not be displayed.
        }
（途中省略）
  # module.lab_env.tls_private_key.generated will be destroyed
  # (because tls_private_key.generated is not in configuration)
  - resource "tls_private_key" "generated" {
（途中省略）
      - private_key_openssh           = (sensitive value) -> null
（途中省略）
Plan: 2 to add, 0 to change, 3 to destroy.

Changes to Outputs:
  - generated_private_key = (sensitive value) -> null
```

イメージには`ignore_changes = [build]`を付けているため（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション3）、`build_args`を消しただけでは、イメージは作り直されず、tfstateの値も残ります。パスワードを記録したイメージを作り直すため、`triggers`を加えています。イメージが作り直されると、それを使うコンテナも作り直しになります。

stgとprodは、作り直しを含むplanなので、`allow_destroy`を選んで適用しました。prodの適用の結果です。

**▼ 実行結果**（「GitOps Apply」の実行#79、`terraform-apply`ジョブのステップ「Terraform apply (saved plan)」から抜粋）

```plaintext
332935fadf692abf26c05059fb380bcdbaaa5dbe8c2eb8fc437119959408a33d  /home/control/gitops-pending/prod/tfplan
module.lab_env.docker_container.targets["target-node2"]: Destroying... [id=474e01a930f6a847843bd0b8d9ded2aaacf22432f9bcd457e32149b16890ed0d]
（途中省略）
module.lab_env.tls_private_key.generated: Destroying... [id=db52c38d3369370f1734fd16c8c0a6a211b62e15]
module.lab_env.tls_private_key.generated: Destruction complete after 0s
module.lab_env.docker_image.this: Destroying... [id=sha256:35887767a57b8b99c30bdfc169c04a16a4786e3bbb124451d9d84972b65115f0ansible-target:ubuntu22.04]
module.lab_env.docker_image.this: Destruction complete after 0s
module.lab_env.docker_image.this: Creating...
module.lab_env.docker_image.this: Creation complete after 4s [id=sha256:580e369fb41b08cc58beded6d6ab0ee567a68bf62d82c8c87eeb7c1bb2aa88b6ansible-target:ubuntu22.04]
（途中省略）
Apply complete! Resources: 4 added, 0 changed, 5 destroyed.
```

**▼ 実行結果**（「GitOps Apply」の実行#79、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
changed: [target-node3]
changed: [target-node1]
changed: [target-node2]
（途中省略）
target-node1               : ok=6    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=6    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=6    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

作り直したコンテナに、Ansibleが2つのファイルとパスワードを設定し直しました（`changed=3`）。Secretsの新しい鍵で、5台すべてに接続できています。

### ■ 検証内容：tfstateとイメージの履歴に秘密が残っていないか

3環境に適用した後、tfstateに秘密鍵と古いパスワードが残っていないかを確かめます。値は表示せず、件数と位置だけを出します。古いパスワードは、手元の変数ファイルに残っていた値を照合に使い、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** と同じく完全一致で探します。

**実行コマンド**

```plaintext
for e in dev stg prod; do
  echo "== $e"
  p=$(sed -n 's/^ansible_user_password *= *"\(.*\)"$/\1/p' terraform/envs/$e/terraform.tfvars)
  s=$(terraform -chdir=terraform/envs/$e state pull)
  echo "tls_private_key_resources=$(printf '%s' "$s" | jq '[.resources[] | select(.type == "tls_private_key")] | length')"
  echo "private_key_lines=$(printf '%s' "$s" | grep -c 'PRIVATE KEY')"
  echo "outputs=$(printf '%s' "$s" | jq -c '.outputs | keys')"
  echo "old_password_paths:"
  printf '%s' "$s" | jq -r --arg p "$p" 'paths(. == $p) | map(tostring) | join(".")'
  unset s p
done
```

**▼ 実行結果**

```plaintext
== dev
tls_private_key_resources=0
private_key_lines=0
outputs=["network_name","target_nodes","target_nodes_ips"]
old_password_paths:
== stg
tls_private_key_resources=0
private_key_lines=0
outputs=["network_name","target_nodes","target_nodes_ips"]
old_password_paths:
== prod
tls_private_key_resources=0
private_key_lines=0
outputs=["network_name","target_nodes","target_nodes_ips"]
old_password_paths:
resources.2.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
```

prodに1か所だけ残った`resources.2`がどのリソースかと、イメージの履歴を確かめます。

**実行コマンド**

```plaintext
terraform -chdir=terraform/envs/prod state pull | jq -r '.resources[2] | "\(.module // "-") \(.type).\(.name)"'
for i in ansible-target:ubuntu22.04-dev ansible-target:ubuntu22.04-stg ansible-target:ubuntu22.04; do
  echo "$i id=$(docker image inspect -f '{{.Id}}' "$i" | cut -c8-19) arg_lines=$(docker history --no-trunc "$i" | grep -c 'ARG ANSIBLE_USER_PASSWORD') chpasswd_lines=$(docker history --no-trunc "$i" | grep -c 'chpasswd')"
done
docker history --no-trunc ansible-target:ubuntu18.04 | grep -c 'chpasswd'
```

**▼ 実行結果**

```plaintext
- docker_image.ansible_target_legacy
ansible-target:ubuntu22.04-dev id=580e369fb41b arg_lines=0 chpasswd_lines=0
ansible-target:ubuntu22.04-stg id=580e369fb41b arg_lines=0 chpasswd_lines=0
ansible-target:ubuntu22.04 id=580e369fb41b arg_lines=0 chpasswd_lines=0
1
```

### ■ 結果

3環境のtfstateから、`tls_private_key`、秘密鍵の行、出力`generated_private_key`が消えました。使っているイメージ（3環境とも`580e369fb41b`）の履歴にも、パスワードを受け取る`ARG`と`chpasswd`の行はありません。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で確かめた経路のうち、tfstateとイメージの履歴の2つからは、使っている秘密がなくなりました。作り直す前のイメージ（`339abaa620aa`と`35887767a57b`）は、モジュールのイメージに`keep_locally = true`を付けていましたが、タグのないものも含めて、一覧に残っていませんでした。

コンテナでは、5台とも`ansible`のパスワードのハッシュが`$6$rounds=656000$`で始まり、Ansibleの`password_hash`で設定した値に置き換わっていました。手元から確認モードで実行すると、5台とも`changed=0`で、ソルトを固定したパスワードのタスクも冪等です。`authorized_keys`は、操作する人の鍵と、その環境の新しい鍵の2つだけになりました。

### 消えないものと、値を入れ替える理由

prodのtfstateには、古いパスワードが1か所残りました。prodの、どのコンテナも使っていない`legacy`のイメージ（`ansible-target:ubuntu18.04`）です。このリソースにも`ignore_changes = [build]`が付いているため、コードから`build_args`を消しても、tfstateの値は書き換わらず、イメージの履歴にも`chpasswd`の行が残っています。管理していないものの整理は **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)** の主題のため、この回では残します。イメージのビルドのキャッシュに古いビルドの記録が残っているか、そこから値を取り出せるかは、この回では確かめていません。

このように、一度tfstateや履歴に入った値は、コードを変えても、すべては消せません。この回で移したパスワードを、移す前と同じ値にせず、新しい値に入れ替えたのはそのためです。古い値は、tfstateとイメージの履歴に加え、GitHubのSecretsと手元の変数ファイルにもありました。新しい値にすれば、消せずに残った古い値は、もうどのコンテナのパスワードでもありません。

### ログの伏せ字が変わった

この変更の後、ジョブのログでは、`ansible`という語が伏せられなくなりました。

**▼ 実行結果**（「GitOps Apply」の実行#79、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）

```plaintext
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
```

一方、prodの`plan`のステップでは、`deploy`が伏せられたままです。

**▼ 実行結果**（「GitOps Pipeline」の実行#135、`terraform-plan`ジョブのステップ「Terraform plan」から抜粋）

```plaintext
  PG_CONN_STR: ***
  TF_VAR_***_user_password: ***
```

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、この検証環境のパスワードがログに頻出する語と同じ値のため、関係のない語まで`***`に伏せられることを確かめていました。`ansible`のパスワードをどのジョブにも渡さなくなったため、その値は伏せる対象から外れました。`TF_VAR_deploy_user_password`を渡しているステップでは、`deploy`が伏せられたままです。伏せ字は、そのジョブに渡したSecretsの値にだけ効いています。

### 元の置き場所を片付ける

**[セクション3](#3-基準に合わない置き方は何を起こすか)** で挙げた、移行で片付ける置き場所を、次のとおり処理しました。

|置き場所|処理|
|---|---|
|GitHubのSecretsの`TF_VAR_ANSIBLE_USER_PASSWORD`|削除した|
|手元の3環境の`terraform.tfvars`の`ansible_user_password`|行を削除した。削除後、3環境とも`terraform plan`の差分はない|
|tfstateの`build_args`|使っているイメージの分は、作り直しで消えた。`legacy`の分は残っている|
|イメージの履歴|使っているイメージの分は、作り直しで消えた。`legacy`の分は残っている|

tfstateから書き出していた手元の古い秘密鍵（`ansible/keys/<環境>/`）も削除しました。対になる公開鍵は、もうどのコンテナにも入っていません。今、`ansible`のパスワードがある場所は、Gitの中の暗号文だけです。コンテナに入っているのは、その値から作ったハッシュです。

### クラウドでも同じ形になる

AWSのプロバイダーで、EC2のインスタンスに接続用の鍵を登録する`aws_key_pair`は、公開鍵を受け取るリソースです（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション8）。この公開鍵を`tls_private_key`から作ると、この検証環境と同じく、秘密鍵がtfstateに残ります。外で作った公開鍵を`file`で渡せば、tfstateに入るのは公開鍵だけです。GCPのインスタンスのメタデータの`ssh-keys`も、公開鍵を渡す点は同じです。値をtfstateに残さない仕組みが使えるかどうかは、クラウドのプロバイダーでも、リソースごとに確かめる必要があります。

次のセクションでは、Secretsを環境ごとに分けても残る限界を扱います。

---

[↑ 目次に戻る](#-目次)

---

## 5. Secretsを環境ごとに分けても残る限界

**[セクション4](#4-tfstateに秘密を残さない)** で、接続用の秘密鍵を環境ごとにGitHubのSecretsに置きました。ここでは、Secretsを環境ごとに分けたときに、どこまで分離でき、何が残るのかを確かめます。

### 名前を分けても、リポジトリのSecretsは分離されない

**[セクション4](#4-tfstateに秘密を残さない)** で登録した`CONNECT_PRIVATE_KEY_DEV`・`CONNECT_PRIVATE_KEY_STG`・`CONNECT_PRIVATE_KEY_PROD`は、リポジトリのSecretsです。「GitOps Apply」では、選んだ環境の秘密鍵だけをジョブに渡しています。ただし、これはワークフローの書き方で選んでいるだけで、GitHubが分けているわけではありません。

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション7で確かめたとおり、リポジトリのSecretsは、作業用のブランチに置いたワークフローからも読めます。作業用のブランチにワークフローを置ける人は、prodの秘密鍵を受け取るジョブも書けます。名前を環境ごとに分けても、どの秘密をどのジョブに渡すかを決めているのは、ワークフローを書く人です。

### Environmentで分けたとき、プルリクエストのジョブはどう扱われるか

GitHubには、シークレットを環境（Environment）ごとに置き、その環境を参照できるブランチを規則で絞る仕組みがあります。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション7では、公式ドキュメントでは非公開のリポジトリで使うには上位のプランが必要とされているのに対し、この検証環境では、Environmentのシークレットもブランチの規則も効きました。規則に当てはまらない作業用のブランチのジョブは、シークレットを受け取れずに止まっています。

同じ回で、確かめずに残した点があります。プルリクエストの確認のジョブは、作業用のブランチではなく、`refs/pull/<番号>/merge`という参照で動きます。このジョブが、ブランチの規則にどう照合されるかです。

### ■ 検証内容：プルリクエストのジョブは、ブランチの規則にどう照合されるか

確認用のEnvironment`gitops15-check`を作り、シークレット`GITOPS15_ENV_CHECK`（24文字のダミーの値）と、`main`だけを許すブランチの規則を設定しました。作業用のブランチに、次のワークフローを置きます。Environmentを参照する`with-env`と、参照しない`without-env`で、違いは`environment:`の1行だけです。

* **ファイル名：`.github/workflows/gitops15-env-check.yml`**

```yaml
name: Env PR Check

on:
  pull_request:
    branches:
      - main

jobs:
  with-env:
    runs-on: [self-hosted, Linux, X64]
    environment: gitops15-check
    steps:
      - name: Show ref and secret length
        env:
          CHECK: ${{ secrets.GITOPS15_ENV_CHECK }}
          REF: ${{ github.ref }}
          HEAD_REF: ${{ github.head_ref }}
        run: echo "ref=$REF head_ref=$HEAD_REF length=${#CHECK}"

  without-env:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - name: Show ref and secret length
        env:
          CHECK: ${{ secrets.GITOPS15_ENV_CHECK }}
          REF: ${{ github.ref }}
          HEAD_REF: ${{ github.head_ref }}
        run: echo "ref=$REF head_ref=$HEAD_REF length=${#CHECK}"
```

このブランチから`main`へのプルリクエスト#75を作ると、「Env PR Check」の実行#1が動き、`with-env`は失敗、`without-env`は成功しました。

**▼ 実行結果**（「Env PR Check」の実行#1、`without-env`ジョブのステップ「Show ref and secret length」から抜粋）

```plaintext
env:
  CHECK: 
  REF: refs/pull/75/merge
  HEAD_REF: gitops15-env-check
ref=refs/pull/75/merge head_ref=gitops15-env-check length=0
```

失敗した`with-env`には、ジョブのログがありません。理由は、実行の概要の画面の「Annotations」に出ていました。

**▼ 実行結果**（「Env PR Check」の実行#1の概要の画面、「Annotations」から）

```plaintext
Branch "refs/pull/75/merge" is not allowed to deploy to gitops15-check due to environment protection rules.
The deployment was rejected or didn't satisfy other protection rules.
```

規則と照合されたのは、元のブランチの`gitops15-env-check`ではなく、`refs/pull/75/merge`でした。そこで、規則を足しながら、同じ実行の`with-env`だけをやり直します。プルリクエスト、コミット、ワークフローは変えず、変えるのは規則だけです。

|試行|ブランチの規則|`with-env`|
|---|---|---|
|1回目|`main`|失敗（上の「Annotations」）|
|2回目|`main`、`gitops15-env-check`|失敗（「Annotations」は1回目と同じ文言）|
|3回目|`main`、`gitops15-env-check`、`refs/pull/*/merge`|成功|

3回目の試行の前の規則の一覧です。`main`と`gitops15-env-check`の規則には「Currently applies to 1 branch」、`refs/pull/*/merge`の規則には「Currently applies to pull requests」と表示されていました。

![確認用のEnvironmentのブランチの規則（refs/pull/*/merge の規則は pull requests に当てはまる）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/section5-environment-rules.png)

**▼ 実行結果**（「Env PR Check」の実行#1の3回目の試行、`with-env`ジョブのステップ「Show ref and secret length」から抜粋）

```plaintext
env:
  CHECK: ***
  REF: refs/pull/75/merge
  HEAD_REF: gitops15-env-check
ref=refs/pull/75/merge head_ref=gitops15-env-check length=24
```

### ■ 結果

プルリクエストのジョブは、元のブランチの名前ではなく、`refs/pull/<番号>/merge`の名前でブランチの規則と照合されました。元のブランチの名前を規則に足しても通らず、`refs/pull/*/merge`の規則を足したときだけ、Environmentのシークレットを受け取れました。Environmentを参照しない`without-env`は、ジョブとしては動きますが、Environmentのシークレットは空（`length=0`）です。

このことから、prodの秘密鍵をEnvironmentに置いて`main`だけに許すと、プルリクエストの確認のジョブは、prodに接続できなくなります。今のパイプラインでは、prodへの確認モードの実行は、マージの後の`main`の実行（承認待ちを作る実行）だけで行うことになります。

プルリクエストの段階でもprodを確かめるには、`refs/pull/*/merge`の規則が必要です。しかし、この規則は、画面の表示のとおりプルリクエスト全体に当てはまり、どのブランチから作ったプルリクエストにもprodのシークレットを渡します。ブランチで分けるために置いた規則が、プルリクエストを通じて、分ける前と同じ範囲に戻ることになります。

### それでも残る限界

Environmentで`main`だけに許しても、次の限界は残ります。どれも、GitHubの設定では分けられないものです。

|残る限界|理由|
|---|---|
|mainへの直接プッシュ|`main`に直接プッシュしたワークフローは、`main`の規則に当てはまり、prodのシークレットを受け取れる。この検証環境では、mainへの直接プッシュは止められない（**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5）|
|同じホストのself-hostedランナー|どの環境のジョブも、同じホストの同じユーザーで動く。ジョブが書き出した秘密鍵や、承認待ちの保存したplanは、そのユーザーなら読める|
|操作する人の鍵|1つの鍵が、3つの環境のすべてのコンテナに入っている（**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション4）|
|手元のすべての鍵|手元には、3環境の接続用の秘密鍵とVaultパスワードがそろっている|

GitHubのSecretsで分けられるのは、どのワークフローのどのジョブに値を渡すかまでです。値を受け取ったジョブが動くホストや、値を持っている人は、分けられません。

### どこを信頼するかを選ぶ

分離をこれ以上強くするには、信頼する範囲をどこに引くかを選ぶことになります。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6で整理した信頼の境界の上で、取りうる選択肢は次の4つです。

* 今の構成：Secretsの名前とワークフローで分ける
* Environment：Environmentで分け、`main`だけに許す
* ランナー：環境ごとにランナーのホストやユーザーを分け、ラベルで振り分ける
* リポジトリ：環境ごとにリポジトリを分ける

|選択肢|信頼するもの、代わりに増えるもの|
|---|---|
|今の構成|ワークフローを書ける人と、ランナーのホストを信頼する。分離は、ワークフローの書き方とレビューに頼る|
|Environment|`main`に入るコミットを信頼する。プルリクエストの段階では、その環境を確かめられない。mainへの直接プッシュは止められないため、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** と同じく、適用の前で止める仕組みと組み合わせる|
|ランナー|環境ごとのランナーを信頼する。ランナーの数だけ、運用と更新が増える|
|リポジトリ|リポジトリごとの、変更できる人を信頼する。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション4で挙げた、マルチリポの代償（実行順序、接続面の受け渡し、コミットの組み合わせの記録）が増える|

この検証環境では、今の構成（Secretsの名前とワークフローで分ける）を続けます。どの環境のジョブも同じホストの同じユーザーで動く以上、Environmentで分けても、ホストの上では分かれないためです。この選び方は、環境の数や、prodに触れてよい人の範囲で変わります。

なお、Environmentのシークレットとブランチの規則が非公開のリポジトリで効いたことは、公式ドキュメントの記述とは異なる、この検証環境での実測です。今後のプランや仕様の変更で変わる可能性があります。

|項目|公式ドキュメント|この検証環境での実測|
|---|---|---|
|Environmentのシークレット（非公開のリポジトリ）|上位のプランが必要|設定でき、規則に当てはまるジョブだけが受け取れた（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**）|
|ブランチの規則（非公開のリポジトリ）|上位のプランが必要|効いた。プルリクエストのジョブは`refs/pull/<番号>/merge`の名前で照合された（この回）|

クラウドでも、この構造は変わりません。クラウドの認証情報を環境ごとに分けても、それを受け取るランナーが同じホストで動けば、ホストの上では分かれません。環境ごとに認証情報の権限を絞ることはできますが、その認証情報を、長期間有効な鍵として外部に預けるかどうかは別の問題です。次のセクションでは、長期間有効な鍵を外部に預けない仕組みを扱います。

---

[↑ 目次に戻る](#-目次)

---

## 6. 長期間有効な鍵を預けないOIDC

クラウドの認証情報を、長期間有効な鍵としてGitHubのSecretsに置かずに済ませる仕組みとして、OIDCを扱います。この検証環境には連携先のクラウドがないため、実機では動かさず、公式ドキュメントで確認した仕組みと設定の対比にとどめます。

### Secretsに置く鍵は、外部に預けたままになる

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6では、GitHubとself-hostedランナーの構成を、コード、Secrets、ジョブのログをGitHubに預ける線の引き方として整理しました。そのうえで、GitHubを選んだ場合でも、長期間有効なクラウドの認証情報をSecretsに置かずに済ませる方法がある、としていました。

クラウドのプロバイダーをTerraformで使うと、ツールを動かすための鍵に、クラウドの認証情報が加わります（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション7）。アクセスキーのような認証情報をSecretsに置くと、その鍵は、入れ替えるまでGitHubの上で有効なまま預けられます。**[セクション5](#5-secretsを環境ごとに分けても残る限界)** で見たとおり、Secretsに置いた値は、ワークフローを書ける人なら、どのジョブにも渡せます。漏れたときに使える期間は、鍵を入れ替えるまでの期間です。

### OIDCでは、ジョブのたびに短期間の認証情報を受け取る

GitHub Actionsでは、ジョブごとに、GitHubがOIDCのトークンを発行します。クラウドの側は、GitHubを信頼する相手として登録しておき、受け取ったトークンの内容を、あらかじめ設定した条件と照らし合わせます。条件に合えば、そのジョブの間だけ有効なアクセストークンを渡します（**[OpenID Connect](https://docs.github.com/en/actions/concepts/security/openid-connect)**）。

|項目|長期間有効な鍵をSecretsに置く|OIDC|
|---|---|---|
|GitHubに預けるもの|クラウドの認証情報そのもの|なし（クラウドの側に、GitHubを信頼する設定を置く）|
|認証情報が有効な期間|入れ替えるまで|そのジョブの間だけ|
|どのジョブが使えるか|ワークフローの書き方で決まる|クラウドの側の条件で決まる|
|入れ替え|人が定期的に行う|ジョブのたびに新しくなる|

ワークフローの側では、トークンを要求するために、ジョブかワークフローに`id-token: write`の権限を付けます。この権限がないと、トークンを要求できません（**[OpenID Connect reference](https://docs.github.com/en/actions/reference/security/oidc)**）。AWSの場合の設定の例は、次のとおりです。この回では動かしていません。

* **ファイル名：`.github/workflows/gitops-apply.yml`**（設定の例）

```yaml
permissions:
  id-token: write
  contents: read

jobs:
  terraform-apply:
    environment: prod
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::123456789012:role/gitops-terraform-prod
          aws-region: ap-northeast-1
```

ロールの側の信頼の条件で、トークンの`sub`を照合します。GCPでも、Workload Identity連携で同じ構造の設定をします。

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:environment:prod"
  }
}
```

### 条件は、セクション5と同じ構造になる

公式ドキュメントでは、トークンの`sub`は、ジョブの種類によって次の形になります。

|ジョブ|`sub`の形|
|---|---|
|Environmentを使うジョブ|`repo:ORG-NAME/REPO-NAME:environment:ENVIRONMENT-NAME`|
|プルリクエストのジョブ|`repo:ORG-NAME/REPO-NAME:pull_request`|
|ブランチのジョブ|`repo:ORG-NAME/REPO-NAME:ref:refs/heads/BRANCH-NAME`|

プルリクエストのジョブの`sub`には、ブランチの名前が入りません。クラウドの側の条件を`main`のブランチやprodのEnvironmentに絞ると、プルリクエストの確認のジョブは、prodの認証情報を受け取れません。プルリクエストにも許す条件にすれば、どのブランチから作ったプルリクエストにも許すことになります。**[セクション5](#5-secretsを環境ごとに分けても残る限界)** で、Environmentのブランチの規則が`refs/pull/<番号>/merge`で照合されたのと同じ構造です。違うのは、条件を判定する場所がGitHubではなく、クラウドの側にあることです。

### OIDCで置き換えられないもの

OIDCで置き換えられるのは、OIDCのトークンを受け付けるサービスの認証情報です。この検証環境の接続用の秘密鍵とVaultパスワードは、その対象ではありません。

|鍵|OIDCで置き換えられるか|
|---|---|
|クラウドの認証情報|置き換えられる（クラウドの側がOIDCに対応している場合）|
|接続用の秘密鍵|置き換えられない。操作対象のsshdは、OIDCのトークンを受け付けない|
|Vaultパスワード|置き換えられない。Ansible Vaultは、OIDCのトークンを受け付けない|

また、短期間の認証情報であっても、ジョブの間は有効です。**[セクション5](#5-secretsを環境ごとに分けても残る限界)** で挙げた、同じホストのself-hostedランナーの限界は、OIDCでも残ります。OIDCが狭めるのは、外部に預ける範囲と、漏れたときに使える期間です。どのジョブにどの権限を渡すかを決める場所が、ワークフローからクラウドの側の条件に移ります。

次のセクションでは、クラウドのシークレット管理サービスを加えたときに、ここまでの構造が変わるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. クラウドのシークレット管理サービスを加えても構造は同じ

クラウドを使う場合は、AWS Secrets ManagerやGCP Secret Managerのような、クラウドのシークレット管理サービスが、Ansible VaultとGitHub Secretsに加わる3つ目の置き場所になります。ここでは、置き場所が増えても、**[セクション2](#2-秘密が何と一緒に変わるかで境界線を引く)** の基準と構造が変わらないことを整理します。この検証環境には連携先のクラウドがないため、実機では確かめていません。

### 置き場所が増えても、基準は「何と一緒に変わるか」

シークレット管理サービスに置いた値は、Gitの外にあります。Ansibleからは、lookupのプラグインで、実行のときに値を読み出せます。Gitに置くのは、どの名前の値を読むかという参照だけです。

この形は、**[セクション3](#3-基準に合わない置き方は何を起こすか)** の置き方1（操作対象に入れる値を、Secretsで渡す）と同じ構造です。値を変えても、Gitにコミットは残らず、プルリクエストのレビューも承認ゲートも通りません。シークレット管理サービスには、値の版の履歴や、誰が読めるかの権限の設定があります。ただ、それはGitの外の履歴と権限で、Gitの仕組みの中にはありません。

そのため、置き場所は、これまでと同じ基準で決めます。

|置き場所|置くもの|
|---|---|
|Gitの中（Ansible Vault）|Playbookのコードと一緒に変わる、操作対象に入れる秘密の値|
|クラウドのシークレット管理サービス|Gitの外で、コードとは別のきっかけで変わる値（ほかのシステムと共有する値、サービスの側で自動的に入れ替える値など）|
|GitHub Secrets|パイプラインの実行環境と一緒に変わる、ツールを動かすための鍵|

シークレット管理サービスを選ぶ理由は、値がコードとは別のきっかけで変わることです。コードと一緒に変わる値を移せば、Gitに残せていた変更の記録を手放すことになります。

### 2層の構造も変わらない

シークレット管理サービスから値を読むには、そのサービスにアクセスするための認証情報が要ります。これはツールを動かすための鍵で、**[セクション6](#6-長期間有効な鍵を預けないoidc)** のOIDCで受け取れます。

```
Gitの中
　└─ 操作対象に入れる秘密の値（Ansible Vaultの暗号文）
Gitの外
　├─ シークレット管理サービスの値
　│　　　↑ 読み出す
　├─ クラウドの認証情報（OIDCで、ジョブのたびに受け取る）
　└─ Vaultパスワード、そのほかのツールを動かすための鍵（GitHub Secrets、人の手元）
```

**[セクション2](#2-秘密が何と一緒に変わるかで境界線を引く)** で示した、SecretsがVaultを開く鍵を持つ構造と同じです。どの置き場所の値も、最後はGitの外にある鍵1つの後ろに集まります。置き場所を増やしても、守るべき鍵がなくなるわけではありません。

### Terraformで読めば、tfstateに残る

シークレット管理サービスの値を、Terraformのデータソースで読むと、その値はデータソースの属性としてtfstateに記録されます。**[セクション4](#4-tfstateに秘密を残さない)** で、Terraformに秘密を渡すと残ることを確かめたのと同じです。値をtfstateに残さずに読めるかどうかは、**[セクション4](#4-tfstateに秘密を残さない)** と同じく、使うプロバイダーとリソースが、ephemeralな値や書き込み専用の属性に対応しているかで決まります。

操作対象に入れる値は、Terraformを通さず、Ansibleが実行のときに読み出す形にすれば、tfstateには入りません。シークレット管理サービスを加えても、どちらのツールに値を持たせるかは、**[セクション2](#2-秘密が何と一緒に変わるかで境界線を引く)** と同じく、その値が何と一緒に変わるかから決まります。

この構造は、AWS・GCPのどちらでも同じです。置き場所の名前が変わっても、何と一緒に変わるかで置き場所を決める基準と、Gitの中はVault、Gitの外は鍵という2層の構造は変わりません。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* Ansible VaultとGitHub Secretsのどちらに置くかは、どちらが安全かではなく、その秘密が何と一緒に変わるかで決まる。操作対象に入れる秘密の値は、Playbookのコードと一緒に変わる「決めたこと」なので、Ansible Vaultで暗号化してGitの中に置き、レビューと履歴の対象にする。ツールを動かすための鍵は、パイプラインの実行環境と一緒に変わるので、GitHubのSecretsと人の手元に置く。Vaultパスワードもツールを動かすための鍵で、SecretsがVaultを開く鍵を持つ2層の構造になる。どちらのツールが使うかは今の実装で決まっているにすぎず、ライフサイクルで置き場所を決めると、どちらのツールに持たせるかもそれに合わせて決まる
* 基準に合わない置き方として、操作対象に入れる値をSecretsで渡す、接続用の秘密鍵をVaultで暗号化してGitに置く、同じ秘密を複数の場所に置く、の3つを、今のパイプラインの実例から整理した。値の変更がGitに残らずレビューも承認も通らない、入れ替えのたびにコミットが要り過去の鍵が履歴に残る、どの値が正しいかが決まらない、という帰結は、どれも秘密が何と一緒に変わるかと置き場所が合っていないことから起きる。移すときは、元の置き場所をなくすまでが移行である
* この検証環境のプロバイダーは、値をtfstateに残さない書き込み専用の属性を持たず、ephemeralな鍵の値を、tfstateに記録される属性に渡すと`plan`の段階で止まることを実機で確認した。そこで、Terraformで秘密を作らない、Terraformに秘密を渡さない形に変えた。接続用の鍵はTerraformの外で作って公開鍵だけを渡し、秘密鍵は環境ごとにSecretsに置いた。ユーザーのパスワードは新しい値に入れ替えてAnsible Vaultに移し、Ansibleがユーザーに設定する形にした。3環境に適用した後、tfstateから秘密鍵と使っているパスワードが消え、使っているイメージの履歴からもパスワードを設定する行が消えたことを確認した。`ignore_changes`を付けた使っていないイメージには、古い値が残った
* `no_log: true`を付けたタスクが失敗すると、失敗した理由まで隠れることを実機で確認した。原因は、秘密を使わない形で同じ処理を再現して探した。また、Terraformの変数でパスワードを渡さなくなった後は、ジョブのログでその値の語が伏せられなくなり、伏せ字はそのジョブに渡したSecretsの値にだけ効くことを確認した
* リポジトリのSecretsは、名前を環境ごとに分けても、ワークフローを書く人がどのジョブにも渡せる。Environmentのブランチの規則では、プルリクエストのジョブは元のブランチの名前ではなく`refs/pull/<番号>/merge`の名前で照合され、`main`だけを許す規則では止まり、元のブランチの名前を足しても通らず、`refs/pull/*/merge`の規則を足したときだけ通ることを実機で確認した。その規則はプルリクエスト全体に当てはまる。Environmentで分けても、mainへの直接プッシュ、同じホストのself-hostedランナー、操作する人の鍵、手元のすべての鍵という限界は残り、分離を強くするには、どこを信頼するかを選ぶことになる
* クラウドの認証情報は、OIDCを使えば、長期間有効な鍵をSecretsに置かずに、ジョブのたびに短期間の認証情報を受け取れる。どのジョブに渡すかの条件はクラウドの側に移るが、プルリクエストのジョブの`sub`にはブランチの名前が入らず、Environmentの規則と同じ構造になる。接続用の秘密鍵やVaultパスワードのように、OIDCのトークンを受け付けない鍵は置き換えられない
* クラウドのシークレット管理サービスを加えても、何と一緒に変わるかで置き場所を決める基準と、Gitの中はVault、Gitの外は鍵という2層の構造は、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

本シリーズの **[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** では、「Gitに置くが読めなくする」選択肢として、Ansible VaultをGitOpsのパイプラインに組み込み、暗号化した値がVaultパスワードに集まることと、Vaultパスワードの渡し方、self-hostedランナーに残る一時ファイル、暗号化の単位とレビュー、`--check --diff`のログに出る復号した値を実機で確かめました。第15回となる今回は、どの秘密をAnsible Vaultで扱い、どの秘密をGitHubのSecretsで扱うかを、「その秘密が何と一緒に変わるか」というライフサイクルを基準に確定させました。基準に合わない置き方の帰結を今のパイプラインの実例から整理し、Terraformが作っていた接続用の鍵と、Terraformを経由していたユーザーのパスワードを移して、tfstateとイメージの履歴に秘密が残らなくなることを実機で確かめました。そのうえで、プルリクエストのジョブがEnvironmentの規則にどう照合されるかを確かめ、Secretsを環境ごとに分けても残る限界と、どこを信頼するかの選択肢を整理し、長期間有効な鍵を外部に預けないOIDCの考え方と、クラウドのシークレット管理サービスを加えても構造が変わらないことを示しました。

今回は、秘密を正しい置き場所に移すところまでを扱いました。置き場所が決まっても、Vaultパスワードや接続用の秘密鍵が漏れたとき、あるいは失われたときにどうするかは、まだ決めていません。今回、ユーザーのパスワードを新しい値に入れ替えたのは、tfstateやイメージの履歴に残って消せない古い値を無効にするためでした。同じことを、Vaultパスワードそのものや、Gitの履歴に残った暗号文に対して行う必要があります。

次回は、機密情報が漏洩した場合と破損した場合を分け、何を、どの順序で入れ替えるのかを扱います。GitHubのSecretsが読み出せないこと、Vaultパスワードを変えても過去の暗号文は守れないことを確かめ、秘密の値そのものの入れ替えをパイプラインに通して、Vault IDで段階的に切り替えます。あわせて、入れ替えのコミットをrevertしてはいけない理由を、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のロールバックの非対称性と接続して整理します。

**[次回：第16回：Vault情報が漏洩・破損した場合の復旧設計](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)　｜　[次の記事：【GitOps編】第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第3部まとめブログ：機密情報は「どこに置くか」だけでなく「どこに残るか」で設計する** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第3部：GitOpsパイプラインでの機密情報管理

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)**|なぜGitリポジトリに機密情報を置いてはいけないのか|「すべてをGitに置く」GitOpsと機密情報の衝突を出発点に、非公開リポジトリでも十分ではない理由をGitの履歴で確かめる。第2部で暫定のまま残した機密情報を2種類に分類して棚卸しし、tfstate・保存したplan・イメージの履歴・ジョブログというGit以外の漏洩経路を実機で示す。Ansible×Terraformシリーズ第18回との接続を示す。第3部の初回。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**|Ansible VaultをGitOpsパイプラインで安全に扱う|暗号化した値がVaultパスワードに集まることを出発点に、Vaultパスワードの渡し方とself-hostedランナーに残る一時ファイル、暗号化の単位とプルリクエストの差分、`--check --diff`のログに出る復号した値を実機で確かめ、レビューで見せたいものと隠したいものの衝突を整理する。暗号化し忘れを止める場所と、環境ごとにVaultパスワードを分けたときの限界を示す。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**|Ansible VaultとGitHub Secretsの役割分担|「その秘密が何と一緒に変わるか」というライフサイクルを基準に、「Gitの中はVault、Gitの外は鍵」の役割分担を確定させる。基準に合わない置き方の帰結を整理し、Terraformが作っていた接続用の鍵と、Terraformを経由していたユーザーのパスワードを移して、tfstateに秘密が残らなくなることを実機で確かめる。プルリクエストのジョブがEnvironmentの規則にどう照合されるかを確かめ、Secretsを環境ごとに分けても残る限界と、OIDCで長期間有効な鍵を預けない設計を示す。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**|Vault情報が漏洩・破損した場合の復旧設計|漏洩と破損を分け、GitHub Secretsが読み出せないこと、Vaultパスワードの変更では過去の暗号文を守れないことを示す。秘密の値そのものの入れ替えをパイプラインに通し、Vault IDで段階的に切り替える。入れ替えのコミットをrevertしてはいけない理由を第11回と接続する。第3部の最終回。|

---

[↑ 目次に戻る](#-目次)

---