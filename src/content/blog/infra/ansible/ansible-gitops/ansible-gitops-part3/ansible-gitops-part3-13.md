---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第13回：なぜGitリポジトリに機密情報を置いてはいけないのか'
description: '「あるべき状態をすべてGitに置く」GitOpsの考え方と、Gitに平文で置けない機密情報がどこでぶつかるのかを整理する。リポジトリを非公開にしても十分ではない理由をGitの履歴で確かめ、第2部で暫定のまま残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値に分けて棚卸しする。そのうえで、tfstate、保存したplan、イメージの履歴、ジョブのログという、Git以外に機密情報が残る経路を示す。第3部の初回。'
pubDate: 2026-10-15
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', '機密情報管理']
seriesId: 'ansible-gitops-part3'
seriesNo: 13
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/'
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
2. [「唯一の真実」と機密情報は衝突する](#2-唯一の真実と機密情報は衝突する)
3. [非公開リポジトリでも十分ではない理由](#3-非公開リポジトリでも十分ではない理由)
4. [第2部で残した機密情報を棚卸しする](#4-第2部で残した機密情報を棚卸しする)
5. [Git以外にも機密情報は漏れる](#5-git以外にも機密情報は漏れる)
6. [Gitに置かないかGitに置くが読めなくするか](#6-gitに置かないかgitに置くが読めなくするか)
7. [クラウドプロバイダーでも分類と経路は同じ](#7-クラウドプロバイダーでも分類と経路は同じ)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのコードをGitで管理し、GitHub Actionsのパイプラインで適用していて、

* リポジトリは非公開にしている
* パスワードや鍵はGitにコミットせず、GitHubのSecretsから渡している
* よって、機密情報は守られている

と考えていないでしょうか。

機密情報を扱う記事の多くは、平文でコミットしないための注意、Ansible Vaultの使い方、GitHub Secretsの設定方法を、それぞれ個別に扱っています。「あるべき状態をすべてGitに置く」というGitOpsの考え方と、Gitに平文で置けない機密情報が、どこでぶつかるのかや、Gitに置かなかった機密情報がGitの外のどこに残るのかは、あまり扱われていません。AnsibleとTerraformのパイプラインを運用していると、次のような場面にぶつかります。

* 機密情報を含むファイルを削除してコミットしたのに、過去のコミットから中身を取り出せた
* tfstateを開いたら、Ansibleの接続に使う秘密鍵が平文で入っていた
* 承認を待つために保存したplanのファイルに、tfstateの中身がそのまま入っていた
* ビルドしたイメージの履歴に、ビルドのときに渡したパスワードがそのまま残っていた
* ジョブのログで、機密情報とは関係のない語まで`***`に伏せられていた

これらは、コミットの手順や、ツールの設定の問題に見えます。共通しているのは、機密情報をGitに置かないようにしても、機密情報が残る場所がGitの外にもあり、その場所がパイプラインの構造として把握されていない点です。

機密情報の扱いは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。**[Ansible×Terraformシリーズ第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)** では、tfstateをGitで管理するアンチパターンを扱う中で、tfstateに機密情報が平文で含まれる構造に触れました。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、Terraformの変数に`sensitive = true`を指定しても、コンソールの表示で値が隠れるだけで、tfstateには平文のまま記録されることを確認しました。同じ回では、Ansible Vaultがファイルの内容そのものを暗号化することを確かめたうえで、インフラを作るための鍵はTerraform側、インフラの中身に設定する鍵はAnsible Vault側という、機密情報の性質による役割分担を整理しています。これらの回は、手元からTerraformとAnsibleを実行する構成で、機密情報をどちらのツールで管理するかを扱ったもので、変更をGitに通してパイプラインで適用する構成で、機密情報をどこに置き、どこに残るかは扱っていません。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション3では、Terraformが差分の計算に使うtfstateはGitの外にあると整理し、tfstateに含まれる機密情報の扱いを第3部に送りました。同じ回のセクション7では、パスワードや鍵のようにGitに置けない機密情報を、「唯一の真実」が崩れる3つの経路とは性質の異なる課題として位置づけ、インフラのあるべき状態の一部が、最初からGitの外に置かれることになると整理しています。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3では、Gitに置くかどうかを、中身が「決めたこと」か「実行の結果」かで分け、決めたことであっても、パスワードのような秘密の値はGitに置かないとしました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** では、リポジトリを非公開にする理由を、self-hostedランナーで動くコードを書ける人の範囲を限るためと整理し、非公開のリポジトリでも、コード、Secrets、ジョブのログはGitHubに預けていることを示しました。

第2部（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** 〜 **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**）では、パイプラインを組むことを優先し、機密情報の扱いを暫定のまま残してきました。Ansibleの接続に使う秘密鍵は、Terraformが作ってtfstateに記録し、ジョブの中で書き出して使っています。コンテナのユーザーのパスワードと、tfstateのデータベースへの接続文字列は、GitHubのSecretsから渡しています。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、承認待ちとして保存したplanのファイルにtfstateの写しが入ることを確認し、その扱いを第3部に送りました。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** では、デバッグ出力を有効にしても、数えた機密の値はジョブのログに出なかった一方で、ジョブのログの伏せ字は、Secretsに登録した値に一致する文字列にしか効かないことを確認しています。

第3部（第13回〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）では、第2部で暫定のまま残した機密情報を、GitOpsのパイプラインの中で扱える形にしていきます。第13回となる今回は、その前提を作ります。まず、「あるべき状態をすべてGitに置く」というGitOpsの考え方と機密情報が、どこでぶつかるのかを整理します。次に、リポジトリを非公開にしていても十分ではない理由を、Gitの履歴に残る機密情報を実機で確かめながら整理します。そのうえで、第2部で残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値の2種類に分けて棚卸しし、今の検証環境のどこに置かれているかを確かめます。さらに、tfstate、保存したplan、イメージの履歴という、Git以外に機密情報が残る経路を実機で確かめ、ジョブのログについては **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** の結果とあわせて整理します。最後に、「Gitに置かない」と「Gitに置くが読めなくする」という2つの選択肢を位置づけ、AWSやGCPのプロバイダーでも、同じ分類と経路が当てはまることを示します。

なお、第3部は、**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** と内容的なつながりがあります。Ansible×Terraformシリーズ第18回が、手元からTerraformとAnsibleを実行する構成で、機密情報をどちらのツールで管理するかを扱ったのに対し、第3部では、その役割分担を、変更をGitに通してパイプラインで適用する構成の中で組み直し、機密情報をどこに置き、どう渡し、漏洩や破損にどう備えるかを扱います。Ansible×Terraformシリーズを読まれた方には答え合わせとして、初めて読まれる方には入り口として、読み進めていただける構成にしています。

正確に言うと、**GitOpsの機密情報管理は、機密情報をGitに置かないだけでは終わりません。Gitの外にも機密情報が残る場所があり、どこに何が残るかまで含めて設計する必要があります**。この回で扱う問いは、「あるべき状態をすべてGitに置くGitOpsと、Gitに置けない機密情報は、どこでぶつかり、Gitの外のどこに残るのか」です。

次のセクションでは、「唯一の真実」と機密情報が、どこでぶつかるのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 「唯一の真実」と機密情報は衝突する

GitOpsの考え方に従ってあるべき状態をGitに置こうとすると、機密情報のところで何がぶつかるのかを、本シリーズのパイプラインの構成から整理します。

### GitOpsは、あるべき状態をGitに置くことを求める

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション2では、GitOpsの4原則のうち、原則2（バージョン管理と不変性）を、「あるべき状態がGitに保存され、変更がすべて履歴として残るか」という観点で整理しました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3では、Gitに置くかどうかを、中身が「決めたこと」か「実行の結果」かで分け、決めたことはGitに置くとしました。

この考え方に従えば、インフラのあるべき状態を決めるものは、すべてGitに置き、変更はコミットとして履歴に残すことになります。第2部で組んだパイプラインも、Gitに入ったコミットだけをインフラに届ける構造でした。

### 機密情報も、あるべき状態の一部である

ところが、このパイプラインでインフラのあるべき状態を決めているものの中には、機密情報が含まれています。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で作った共通のモジュールの該当箇所は、次のとおりです。

* **ファイル名：`terraform/modules/lab_env/main.tf`（該当箇所）**

```hcl
resource "docker_image" "this" {
  name         = var.image_name
  keep_locally = true
  build {
    context    = var.image_build_context
    dockerfile = "Dockerfile"
    build_args = {
      ANSIBLE_USER_PASSWORD = var.ansible_user_password
    }
  }
  （途中省略：lifecycleブロック）
}

（途中省略：docker_networkの定義）

resource "tls_private_key" "generated" {
  algorithm = "ED25519"
}

resource "docker_container" "targets" {
  （途中省略：名前、イメージ、ネットワーク、ポートの定義）
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${var.operator_public_key}\n${tls_private_key.generated.public_key_openssh}"
  }
  （途中省略：以降の定義）
}
```

コンテナの`ansible`ユーザーのパスワードは、イメージのビルドに渡す値（`build_args`）として、どのパスワードでユーザーを作るかを決めています。Ansibleの接続に使う鍵は、Terraformの`tls_private_key`が作り、その公開鍵がコンテナの`authorized_keys`に入ります。どちらも、操作対象がどういう状態で作られるかを決める値です。

操作対象の外にも、機密情報があります。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** でtfstateをpgバックエンドに移したため、パイプラインがTerraformを動かすには、データベースへの接続文字列が必要です。この値は、インフラのあるべき状態そのものではありませんが、これがなければ、パイプラインはあるべき状態をインフラに届けられません。

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** の基準に当てはめると、どのパスワードでユーザーを作るか、どのデータベースにtfstateを置くかは、人が「決めたこと」です。基準どおりなら、Gitに置くものになります。一方で、これらの値を平文でGitに置けば、リポジトリを読める人は誰でも、操作対象やtfstateに入れることになります。GitOpsの考え方は「Gitに置け」と求め、機密情報の性質は「平文では置けない」と求めます。ここで、2つがぶつかります。

### Gitにあるのは、値の渡し方だけ

今のパイプラインでは、この衝突を、値そのものをGitの外に置くことで避けています。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の「GitOps Apply」の該当箇所は、次のとおりです。

* **ファイル名：`.github/workflows/gitops-apply.yml`（該当箇所）**

```yaml
env:
  TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
  TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
  PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
  TARGET_ENV: ${{ inputs.environment }}
```

ワークフローに書かれているのは、GitHubのSecretsのどの名前の値を、どの環境変数としてジョブに渡すかだけです。値そのものは、Gitの中にはありません。`main.tf`の`backend "pg" {}`にも、接続先は書いていません（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）。

3つの機密情報について、Gitにあるものと、値があるGitの外の場所を並べると、次のとおりです。

|機密情報|Gitにあるもの|値がある場所（Gitの外）|
|---|---|---|
|コンテナのユーザーのパスワード|変数の宣言、`build_args`への渡し方、Secretsを環境変数に渡す指定|GitHubのSecrets、手元の変数ファイル|
|Ansibleの接続に使う鍵|`tls_private_key`の定義、鍵を出力する定義、ジョブの中で鍵を書き出す手順|tfstate|
|tfstateのデータベースへの接続文字列|`backend "pg" {}`（接続先は書かない）、Secretsを環境変数に渡す指定|GitHubのSecrets、手元の設定ファイル|

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4では、AnsibleとTerraformの接続面であるIPアドレスについて、Gitにあるのは値の作り方だけで、値はtfstateと、そこから生成したファイルにしかないことを確認しました。機密情報も、同じ形をしています。Gitにあるのは、値をどこから受け取り、どこへ渡すかという手順だけで、値はGitの外にあります。それぞれの値が、今の検証環境の具体的にどこにあるかは、**[セクション4](#4-第2部で残した機密情報を棚卸しする)** で確かめます。

### Gitの外に置いた値は、Gitの仕組みの外にある

違いは、Gitの外に置いた理由です。IPアドレスは、`terraform apply`の後にしか決まらないため、コミットの時点では書けない値でした。機密情報は、書くことはできるが、平文では書けない値です。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション7では、Gitに置けない機密情報を、「唯一の真実」が崩れる3つの経路とは性質の異なる課題として位置づけました。3つの経路は、Gitに書いたあるべき状態から、実際の状態が離れていく経路です。機密情報は、そもそもあるべき状態の一部を、最初からGitの外に置くことになるという課題です。同じ回のセクション6では、「Gitが唯一の真実」と言えるのは、Gitに記述されている範囲の中だけだと整理しました。機密情報は、設計として、この範囲の外に置かれます。

範囲の外に置いた値には、第2部で積み上げた仕組みが届きません。

* Secretsの値を書き換えても、Gitにコミットは残らない。どの値を、いつ、誰が変えたかは、Gitの履歴からは分からない
* 値の変更は、プルリクエストのレビューも、承認ゲートの入口の確認も通らない
* 値がGitの外のどこに、いくつ残っているかは、Gitを見ても分からない

GitOpsのパイプラインでは、機密情報をGitに置かないことは避けられません。その代わり、Gitの外に置いた値がどこにあり、どこに残るのかを、Gitの仕組みとは別に把握する必要があります。値を平文でGitに置かないための方法は、「Gitに置かない」と「Gitに置くが読めなくする」の2つがあり、その位置づけは **[セクション6](#6-gitに置かないかgitに置くが読めなくするか)** で整理します。

その前に、そもそも「Gitに置く」ことがなぜ危ないのかを確かめておきます。次のセクションでは、リポジトリを非公開にしていても十分ではない理由を、Gitの履歴に残る機密情報から確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 3. 非公開リポジトリでも十分ではない理由

リポジトリを非公開にしていても、機密情報を一度でもGitに置けば守り切れない理由を、Gitの履歴、複製、預け先の3点から、実機で確かめます。

非公開のリポジトリなら、機密情報を誤ってコミットしても、読める人は限られていると考えがちです。しかし、Gitに置いた機密情報には、次の3つの性質があります。

* 履歴は消えない：ファイルを削除しても、過去のコミットに残る
* 複製が増える：クローンするたびに、履歴ごと複製される
* 外部に預けている：非公開のリポジトリでも、置き場所は外部の事業者の上にある

1つ目と2つ目は、手元のローカルのブランチで確かめます。プッシュはせず、値は機密情報ではないダミーの文字列を使います。3つ目は、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** の整理を参照します。

### ■ 検証内容：削除したファイルを、履歴から取り出す

作業用のブランチを作り、ダミーの機密情報を書いたファイルをコミットします。続けて、そのファイルを削除するコミットを作ります。ファイルはリポジトリのルートに置き、拡張子は`.txt`にしました。`.tfvars`は、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で`.gitignore`の対象にしているためです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git status --short; echo "git_status_exit_code=$?"
git switch -c gitops13-history
printf 'gitops13_dummy_password=gitops13-dummy-value\n' > gitops13-dummy-secret.txt
cat gitops13-dummy-secret.txt
git add gitops13-dummy-secret.txt
git commit -m "GitOps第13回: 検証用のダミーの機密情報を追加"
git rm -q gitops13-dummy-secret.txt
git commit -m "GitOps第13回: 検証用のダミーの機密情報を削除"
git log --oneline -3
ls gitops13-dummy-secret.txt; echo "ls_exit_code=$?"
git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
git_status_exit_code=0
Switched to a new branch 'gitops13-history'
gitops13_dummy_password=gitops13-dummy-value
[gitops13-history eacb72f] GitOps第13回: 検証用のダミーの機密情報を追加
 1 file changed, 1 insertion(+)
 create mode 100644 gitops13-dummy-secret.txt
[gitops13-history 9df7394] GitOps第13回: 検証用のダミーの機密情報を削除
 1 file changed, 1 deletion(-)
 delete mode 100644 gitops13-dummy-secret.txt
9df7394 (HEAD -> gitops13-history) GitOps第13回: 検証用のダミーの機密情報を削除
eacb72f GitOps第13回: 検証用のダミーの機密情報を追加
cdec03d (origin/main, main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
ls: cannot access 'gitops13-dummy-secret.txt': No such file or directory
ls_exit_code=2
git_status_exit_code=0
```

作業ツリーからファイルは消え、変更も残っていません。この状態で、履歴から中身を取り出します。コミットが分かっている場合は`git show`で、分からない場合は、値の一部の文字列を手がかりに、すべてのコミットを探します。比べるため、最後に、今の作業ツリーだけを対象にした`git grep`も実行します。

**実行コマンド**

```plaintext
git log --oneline --all -- gitops13-dummy-secret.txt
git show eacb72f:gitops13-dummy-secret.txt
git show 9df7394:gitops13-dummy-secret.txt; echo "exit_code=$?"
git log --oneline --all -S 'gitops13_dummy_password'
git grep -n 'gitops13_dummy_password' $(git rev-list --all); echo "exit_code=$?"
git grep -n 'gitops13_dummy_password'; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
9df7394 (HEAD -> gitops13-history) GitOps第13回: 検証用のダミーの機密情報を削除
eacb72f GitOps第13回: 検証用のダミーの機密情報を追加
gitops13_dummy_password=gitops13-dummy-value
fatal: path 'gitops13-dummy-secret.txt' does not exist in '9df7394'
exit_code=128
9df7394 (HEAD -> gitops13-history) GitOps第13回: 検証用のダミーの機密情報を削除
eacb72f GitOps第13回: 検証用のダミーの機密情報を追加
eacb72fc3f141e1478c950e26c7d55e532d19a01:gitops13-dummy-secret.txt:1:gitops13_dummy_password=gitops13-dummy-value
exit_code=0
exit_code=1
```

### ■ 結果

削除した後のコミット`9df7394`にはファイルがありませんが、その前のコミット`eacb72f`を指定すれば、`git show`で中身をそのまま取り出せました。コミットもファイル名も指定せずに、`gitops13_dummy_password`という文字列だけで探しても、`git log -S`は値が増えたコミットと減ったコミットの2つを、履歴のすべてを対象にした`git grep`は`eacb72f`の中の値を見つけています。今の作業ツリーだけを探す`git grep`では、何も見つかりません（`exit_code=1`）。

ファイルを削除するコミットは、そのコミットから先のファイルをなくすだけで、それより前のコミットを書き換えません。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で扱った`git revert`も、元のコミットを打ち消す新しいコミットを作る操作で、元のコミットは履歴に残ります。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3で、`.gitignore`はすでにコミットしたファイルには効かないと整理しました。後から気づいて除外しても、削除しても、取り消しても、一度コミットした機密情報は、履歴を探せば読めます。「password」のような語で履歴を探すことは、ファイル名を知らない人にもできます。

### ■ 検証内容：クローンした先で、削除した中身を取り出す

このリポジトリを、別の場所にクローンします。クローン先は、開発者の手元や、パイプラインのジョブが作る作業ディレクトリと同じく、リポジトリの複製に当たります。クローン元は手元のリポジトリで、GitHubには何も送っていません。

**実行コマンド**

```plaintext
git clone -q ~/iac/docker-lab-ci /tmp/gitops13-clone
cd /tmp/gitops13-clone
git branch -a
git log --oneline -3
ls gitops13-dummy-secret.txt; echo "ls_exit_code=$?"
git show eacb72f:gitops13-dummy-secret.txt
git grep -n 'gitops13_dummy_password' $(git rev-list --all); echo "exit_code=$?"
cd ~/iac/docker-lab-ci
```

**▼ 実行結果**

```plaintext
* gitops13-history
  remotes/origin/HEAD -> origin/gitops13-history
  remotes/origin/gitops13-history
  remotes/origin/main
9df7394 (HEAD -> gitops13-history, origin/gitops13-history, origin/HEAD) GitOps第13回: 検証用のダミーの機密情報を削除
eacb72f GitOps第13回: 検証用のダミーの機密情報を追加
cdec03d (origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
ls: cannot access 'gitops13-dummy-secret.txt': No such file or directory
ls_exit_code=2
gitops13_dummy_password=gitops13-dummy-value
eacb72fc3f141e1478c950e26c7d55e532d19a01:gitops13-dummy-secret.txt:1:gitops13_dummy_password=gitops13-dummy-value
exit_code=0
```

### ■ 結果

クローン先には、手元のブランチ`gitops13-history`が、`9df7394`、`eacb72f`、`cdec03d`の履歴ごとついてきました。クローン先の作業ツリーにもファイルはありませんが、`git show`と`git grep`で、ダミーの値を取り出せています。

クローンは、その時点の作業ツリーではなく、履歴ごと複製します。機密情報を含むコミットがリポジトリに入れば、そのリポジトリのクローンは、すべてその機密情報を持つことになります。

このパイプラインでは、リポジトリの複製は、人の手元だけにあるわけではありません。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で作った変更されたパスを判定するジョブと、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で作った承認ゲートの入口の確認のジョブは、`fetch-depth: 0`ですべての履歴を取得しています。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション4で確認したとおり、self-hostedランナーの作業ディレクトリは実行をまたいで残り、チェックアウトのたびに掃除されるのは、Gitで管理していないファイルだけです。機密情報を含むコミットがプッシュされれば、その履歴は、ランナーのホストの作業ディレクトリにも複製されて残ることになります（この経路は、ワークフローの設定と第12回の結果からの導出で、実機では確かめていません）。

### ■ 検証内容：ブランチを削除した後に残るもの

クローン先を削除し、mainに戻って、作業用のブランチを削除します。このブランチはmainにマージしていないため、削除には`-D`を使います。そのうえで、ダミーの値を含むコミットが、手元のリポジトリにまだあるかを確かめます。`git cat-file -t`は、指定したオブジェクトがリポジトリの中にあれば、その種類を表示します。

**実行コマンド**

```plaintext
rm -rf /tmp/gitops13-clone
ls -d /tmp/gitops13-clone; echo "ls_exit_code=$?"
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops13-history
git branch -a
git log --oneline -1
git status --short; echo "git_status_exit_code=$?"
git log --oneline --all -- gitops13-dummy-secret.txt; echo "exit_code=$?"
git cat-file -t eacb72f; echo "exit_code=$?"
git show eacb72f:gitops13-dummy-secret.txt; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
ls: cannot access '/tmp/gitops13-clone': No such file or directory
ls_exit_code=2
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops13-history (was 9df7394).
* main
  remotes/origin/main
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
git_status_exit_code=0
exit_code=0
commit
exit_code=0
gitops13_dummy_password=gitops13-dummy-value
exit_code=0
```

### ■ 結果

ブランチを削除すると、`git log --all`は、ファイルに関わるコミットを1つも表示しなくなりました。どのブランチからも、`eacb72f`と`9df7394`にたどり着けなくなったためです。

それでも、`git cat-file -t eacb72f`は`commit`を表示し、`git show`でダミーの値を取り出せました。ブランチの削除は、コミットへの入口をなくすだけで、コミットそのものを、手元のリポジトリからすぐには消しません。ブランチの一覧や`git log --all`に出てこないことは、そのリポジトリに機密情報が残っていないことを意味しません。

このコミットはプッシュしておらず、値もダミーのため、手元のリポジトリから消す操作は行っていません。一度入った機密情報を、履歴とそのすべての複製から取り除くことが、どれだけの作業になるかは、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** で扱います。

### 非公開のリポジトリは、外部の事業者の上にある

3つ目の性質は、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6で整理したとおりです。GitHubとself-hostedランナーの構成では、コード、Secrets、ジョブのログを、GitHubに預けています。非公開にしても、置き場所は外部の事業者の上にあり、プッシュすれば、そこにもう1つ、履歴ごとの複製ができます。

同じ回では、リポジトリを非公開にする理由を、self-hostedランナーで動くコードを書ける人を、インフラを操作してよい人の範囲に限るためと整理しました。非公開は、誰がリポジトリを読めるかを絞る手段です。リポジトリに入った機密情報を、履歴や複製から守る手段ではありません。

### 確かめた性質のまとめ

|性質|確かめたこと|機密情報に起きること|
|---|---|---|
|履歴は消えない|削除した後も、過去のコミットを指定すれば中身を取り出せた。文字列だけで探しても見つかった|削除や取り消しのコミットでは、読めなくならない|
|複製が増える|クローン先にも、履歴ごとついてきた|リポジトリのすべての複製が、機密情報を持つ|
|すぐには消えない|ブランチを削除しても、手元のリポジトリにコミットが残っていた|一覧に出てこないことは、残っていないことを意味しない|
|外部に預けている|（第4回の整理を参照）|非公開でも、外部の事業者の上に複製がある|

リポジトリを非公開にすることは、読める人を限る効果はありますが、一度入った機密情報を取り除く効果はありません。機密情報は、Gitに入れる前に止める必要があります。**[セクション2](#2-唯一の真実と機密情報は衝突する)** で見たとおり、今のパイプラインは、値そのものをGitに置かない形にしています。

では、Gitに置かなかった機密情報は、今どこにあるのでしょうか。次のセクションでは、第2部で暫定のまま残した機密情報を棚卸しし、2種類に分けて、今の検証環境のどこに置かれているかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 4. 第2部で残した機密情報を棚卸しする

第2部で暫定のまま残した機密情報を、2種類に分けて棚卸しし、今の検証環境のどこに置かれ、どこに渡っているかを確かめます。

### 2種類に分ける

**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、機密情報を、インフラを作るための鍵と、インフラの中身に設定する鍵に分けて整理しました。この回では、同じ考え方を、パイプラインから見た形に置き換えて、次の2種類に分けます。

|分類|意味|操作対象との関係|
|---|---|---|
|パイプラインがツールを動かすための鍵|パイプラインや人が、TerraformやAnsibleを動かすために使う認証情報|操作対象の中には入らない（入るのは、対になる公開鍵だけ）|
|操作対象に入れる秘密の値|操作対象の中に設定される値|操作対象の中に入る|

1つ目は、なくなるとパイプラインが動かなくなるもの、2つ目は、操作対象がどういう状態で作られるかを決めるものです。

### ■ 検証内容：Gitの中の、機密情報の受け渡しの記述

まず、Gitで管理しているファイルの中から、機密情報に関わる記述を探します。`git grep`は、Gitで管理しているファイルだけを対象にするため、手元の変数ファイル（`.gitignore`の対象）は出てきません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git log --oneline -1
git grep -n -E 'secrets\.' -- .github/workflows
git grep -n -E 'ANSIBLE_USER_PASSWORD|DEPLOY_USER_PASSWORD|ansible_user_password|deploy_user_password' -- terraform
git grep -n -E 'tls_private_key|generated_private_key|operator_public_key|authorized_keys' -- terraform
git grep -n -E 'backend "pg"|schema_name' -- terraform
git grep -n -E '^ARG' -- terraform
```

**▼ 実行結果**

```plaintext
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
.github/workflows/drift-check.yml:31:          TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
.github/workflows/drift-check.yml:32:          TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
.github/workflows/e2e-provisioning-test.yml:28:          TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
.github/workflows/e2e-provisioning-test.yml:29:          TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
.github/workflows/e2e-provisioning-test.yml:75:          TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
.github/workflows/e2e-provisioning-test.yml:76:          TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
.github/workflows/gitops-apply.yml:33:  TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
.github/workflows/gitops-apply.yml:34:  TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
.github/workflows/gitops-apply.yml:35:  PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
.github/workflows/gitops-pipeline.yml:16:  TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
.github/workflows/gitops-pipeline.yml:17:  TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
.github/workflows/gitops-pipeline.yml:18:  PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
terraform/Dockerfile:17:ARG ANSIBLE_USER_PASSWORD
terraform/Dockerfile:19:    echo "ansible:${ANSIBLE_USER_PASSWORD}" | chpasswd && \
terraform/Dockerfile.deploy_nopasswd:11:ARG DEPLOY_USER_PASSWORD
terraform/Dockerfile.deploy_nopasswd:13:    echo "deploy:${DEPLOY_USER_PASSWORD}" | chpasswd && \
terraform/Dockerfile.deploy_passwd:11:ARG DEPLOY_USER_PASSWORD
terraform/Dockerfile.deploy_passwd:13:    echo "deploy:${DEPLOY_USER_PASSWORD}" | chpasswd && \
terraform/Dockerfile.legacy:14:ARG ANSIBLE_USER_PASSWORD
terraform/Dockerfile.legacy:16:    echo "ansible:${ANSIBLE_USER_PASSWORD}" | chpasswd && \
terraform/envs/dev/main.tf:21:variable "ansible_user_password" {
terraform/envs/dev/main.tf:36:  ansible_user_password = var.ansible_user_password
terraform/envs/prod/main.tf:21:variable "ansible_user_password" {
terraform/envs/prod/main.tf:26:variable "deploy_user_password" {
terraform/envs/prod/main.tf:43:  ansible_user_password = var.ansible_user_password
terraform/envs/prod/main.tf:74:      DEPLOY_USER_PASSWORD = var.deploy_user_password
terraform/envs/prod/main.tf:88:      DEPLOY_USER_PASSWORD = var.deploy_user_password
terraform/envs/prod/main.tf:102:      ANSIBLE_USER_PASSWORD = var.ansible_user_password
terraform/envs/stg/main.tf:21:variable "ansible_user_password" {
terraform/envs/stg/main.tf:36:  ansible_user_password = var.ansible_user_password
terraform/modules/lab_env/main.tf:21:      ANSIBLE_USER_PASSWORD = var.ansible_user_password
terraform/modules/lab_env/variables.tf:21:variable "ansible_user_password" {
terraform/envs/dev/main.tf:37:  operator_public_key   = file("${path.module}/../../id_ed25519.pub")
terraform/envs/dev/outputs.tf:10:output "generated_private_key" {
terraform/envs/dev/outputs.tf:11:  value       = module.lab_env.generated_private_key
terraform/envs/prod/main.tf:44:  operator_public_key   = file("${path.module}/../../id_ed25519.pub")
terraform/envs/prod/main.tf:58:  from = tls_private_key.generated
terraform/envs/prod/main.tf:59:  to   = module.lab_env.tls_private_key.generated
terraform/envs/prod/outputs.tf:10:output "generated_private_key" {
terraform/envs/prod/outputs.tf:11:  value       = module.lab_env.generated_private_key
terraform/envs/stg/main.tf:37:  operator_public_key   = file("${path.module}/../../id_ed25519.pub")
terraform/envs/stg/outputs.tf:10:output "generated_private_key" {
terraform/envs/stg/outputs.tf:11:  value       = module.lab_env.generated_private_key
terraform/modules/lab_env/main.tf:33:resource "tls_private_key" "generated" {
terraform/modules/lab_env/main.tf:50:    file    = "/home/ansible/.ssh/authorized_keys"
terraform/modules/lab_env/main.tf:51:    content = "${var.operator_public_key}\n${tls_private_key.generated.public_key_openssh}"
terraform/modules/lab_env/outputs.tf:18:output "generated_private_key" {
terraform/modules/lab_env/outputs.tf:19:  value     = tls_private_key.generated.private_key_openssh
terraform/modules/lab_env/variables.tf:26:variable "operator_public_key" {
terraform/modules/lab_env/variables.tf:28:  description = "authorized_keysに入れる、操作する人の公開鍵"
terraform/envs/dev/main.tf:3:  backend "pg" {
terraform/envs/dev/main.tf:4:    schema_name = "terraform_remote_state_dev"
terraform/envs/prod/main.tf:3:  backend "pg" {
terraform/envs/prod/main.tf:4:    schema_name = "terraform_remote_state"
terraform/envs/stg/main.tf:3:  backend "pg" {
terraform/envs/stg/main.tf:4:    schema_name = "terraform_remote_state_stg"
terraform/Dockerfile:17:ARG ANSIBLE_USER_PASSWORD
terraform/Dockerfile.deploy_nopasswd:11:ARG DEPLOY_USER_PASSWORD
terraform/Dockerfile.deploy_passwd:11:ARG DEPLOY_USER_PASSWORD
terraform/Dockerfile.legacy:14:ARG ANSIBLE_USER_PASSWORD
```

あわせて、GitHubのリポジトリの「Settings」→「Secrets and variables」→「Actions」の画面で、登録されているSecretsの名前を確認しました。画面に表示されたのは、次の3つです。値は表示されません。

|名前|画面の最終更新の表示|
|---|---|
|`PG_CONN_STR`|last week|
|`TF_VAR_ANSIBLE_USER_PASSWORD`|last month|
|`TF_VAR_DEPLOY_USER_PASSWORD`|last month|

### ■ 結果

Gitの中にあるのは、**[セクション2](#2-唯一の真実と機密情報は衝突する)** で整理したとおり、値の受け渡しの記述だけでした。

* パスワードの2つは、Secretsから`TF_VAR_`の環境変数としてジョブに渡り、各環境の`main.tf`の変数を通って、イメージのビルドの`build_args`に渡る。`Dockerfile`系の4つのファイルは、それを`ARG`で受け取り、`RUN`の中の`chpasswd`で、ユーザーのパスワードとして設定している
* Ansibleの接続に使う鍵は、モジュールの`tls_private_key`で作られ、公開鍵が`authorized_keys`に入る。秘密鍵は、3環境の`generated_private_key`の出力から取り出す
* 3環境の`backend "pg"`には、`schema_name`だけが書かれ、接続先は書かれていない

Secretsを参照しているワークフローは4つありました。「GitOps Pipeline」と「GitOps Apply」は、ワークフロー全体の`env`で3つのSecretsを渡しています。そのため、マージや承認の後のジョブだけでなく、プルリクエストの確認のジョブにも、3つのSecretsが渡ります。「Drift Check」と「E2E Provisioning Test」は、ステップの`env`でパスワードの2つを渡しています。この2つは、ホステッドランナーで動くワークフローなので（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）、パスワードは、GitHubが用意する仮想マシンの上にも渡っています。

Secretsの画面で分かるのは、名前と、おおよその更新時期までです。誰が、どの値に変えたかは、表示されませんでした。

### ■ 検証内容：ランナーのホストにあるもの

次に、ランナーのホスト（操作対象と同じネットワークにあるLinuxホスト）に、機密情報を含むファイルがどこに、どの権限であるかを確かめます。値は表示しません。変数ファイルと接続情報のファイルは、`cut`で`=`より前（変数の名前）だけを表示します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
ls -l ansible/keys/dev ansible/keys/stg ansible/keys/prod
for e in dev stg prod; do echo "== $e"; ls -l terraform/envs/$e/terraform.tfvars; cut -d= -f1 terraform/envs/$e/terraform.tfvars; done
git check-ignore -v ansible/keys/dev/id_ed25519_generated terraform/envs/dev/terraform.tfvars
find ~/iac/docker-lab-ci -name 'terraform.tfstate*' -not -path '*/.terraform/*'
grep -c 'postgres://' terraform/envs/*/.terraform/terraform.tfstate
ls -ld ~/.config/tfstate-backend
ls -l ~/.config/tfstate-backend
cut -d= -f1 ~/.config/tfstate-backend/backend.env ~/.config/tfstate-backend/postgres.env
ls -l ~/.ssh
for f in ~/.ssh/*.pub terraform/id_ed25519.pub; do ssh-keygen -lf "$f"; done
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
ls -la "$RUNNER_WS/ansible/keys" 2>&1
ls -la ~/gitops-pending
```

**▼ 実行結果**

```plaintext
ansible/keys/dev:
total 4
-rw------- 1 control control 387 Oct 11 05:39 id_ed25519_generated

ansible/keys/prod:
total 4
-rw------- 1 control control 387 Oct 11 05:39 id_ed25519_generated

ansible/keys/stg:
total 4
-rw------- 1 control control 387 Oct 11 05:39 id_ed25519_generated
== dev
-rw------- 1 control control 34 Oct 11 03:13 terraform/envs/dev/terraform.tfvars
ansible_user_password
== stg
-rw------- 1 control control 34 Oct 11 03:13 terraform/envs/stg/terraform.tfvars
ansible_user_password
== prod
-rw------- 1 control control 67 Oct 11 00:02 terraform/envs/prod/terraform.tfvars
ansible_user_password
deploy_user_password
.gitignore:13:id_ed25519_generated      ansible/keys/dev/id_ed25519_generated
.gitignore:6:*.tfvars   terraform/envs/dev/terraform.tfvars
terraform/envs/dev/.terraform/terraform.tfstate:0
terraform/envs/prod/.terraform/terraform.tfstate:0
terraform/envs/stg/.terraform/terraform.tfstate:0
drwx------ 2 control control 4096 Oct  7 04:40 /home/control/.config/tfstate-backend
total 8
-rw------- 1 control control 131 Oct  7 04:40 backend.env
-rw------- 1 control control 121 Oct  7 04:40 postgres.env
PG_CONN_STR
POSTGRES_USER
POSTGRES_PASSWORD
POSTGRES_DB
total 36
-rw------- 1 control control    0 Jul  2 07:22 authorized_keys
-rw------- 1 control control  369 Jul  3 06:40 config
-rw------- 1 control control  419 Jul  2 09:22 id_ed25519
-rw-r--r-- 1 control control  107 Jul  2 09:22 id_ed25519.pub
-rw------- 1 control control 3389 Jul  3 04:21 id_rsa
-rw-r--r-- 1 control control  751 Jul  3 04:21 id_rsa.pub
-rw------- 1 control control 7020 Oct 11 06:48 known_hosts
-rw------- 1 control control 6184 Oct 11 05:40 known_hosts.old
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
4096 SHA256:zdjEaNcardq2FFbrcBHzvV9w2K6JIBYzHTKEHP+Npf8 control@ubuntu-controller (RSA)
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
ls: cannot access '/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/keys': No such file or directory
total 8
drwx------  2 control control 4096 Oct 14 02:46 .
drwxr-x--- 14 control control 4096 Oct 15 10:41 ..
```

### ■ 結果

ランナーのホストには、Gitの外に、次の機密情報がありました。

* 3環境の、Ansibleの接続に使う秘密鍵（`ansible/keys/<環境>/`）。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で、手元から接続するためにtfstateから書き出したもの
* 3環境のパスワードの変数ファイル（`terraform/envs/<環境>/terraform.tfvars`）。dev・stgは`ansible_user_password`だけ、prodは`deploy_user_password`も持つ
* tfstateのデータベースへの接続文字列（`~/.config/tfstate-backend/backend.env`）と、PostgreSQLのコンテナを作ったときの初期設定（`postgres.env`）。後者にも、データベースのパスワードが入っている
* 操作する人の鍵（`~/.ssh/id_ed25519`）。Gitにある`terraform/id_ed25519.pub`は、この鍵の公開鍵だった

どのファイルも、本人だけが読める権限（`-rw-------`）で、鍵と変数ファイルは`.gitignore`の行でGitの外に置かれています。3環境の`.terraform/terraform.tfstate`には、接続文字列は書き込まれていませんでした（`0`）。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で、接続情報を環境変数で渡す形にしたためです。

一方、ランナーの作業ディレクトリには鍵は残っておらず、承認待ちのディレクトリも空でした。どちらも、ジョブが動いている間や、承認を待つ間にだけ機密情報を持つ場所です。また、リポジトリの中に、tfstateのファイルは1つもありませんでした。

### ■ 検証内容：操作対象のコンテナに入っている鍵

最後に、5台のコンテナの`authorized_keys`に入っている鍵を確かめます。あわせて、各環境の秘密鍵から公開鍵を作り直して、フィンガープリントを並べます。`ssh-keygen -y`は、秘密鍵から公開鍵を作って出力するだけで、秘密鍵の中身は表示しません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
for c in dev-node1 stg-node1 target-node1 target-node2 target-node3; do echo "== $c"; docker exec $c ssh-keygen -lf /home/ansible/.ssh/authorized_keys; done
for e in dev stg prod; do echo "== $e"; ssh-keygen -y -f ansible/keys/$e/id_ed25519_generated | ssh-keygen -lf -; done
```

**▼ 実行結果**

```plaintext
== dev-node1
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ  (ED25519)
== stg-node1
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:+L8bVR/E3HWvUJekRIKSskKtUA8RgX9irRPIlrhoZMo  (ED25519)
== target-node1
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:GMbi9fSgLhSJ025ImKtSUYbiWImIKFpcdV7+KqEktiQ  (ED25519)
== target-node2
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:GMbi9fSgLhSJ025ImKtSUYbiWImIKFpcdV7+KqEktiQ  (ED25519)
== target-node3
256 SHA256:Apv1HUrZU6PG/NvE39Ie6vNEMr27mBpAQYoHu80HjzQ control@ubuntu-controller (ED25519)
256 SHA256:GMbi9fSgLhSJ025ImKtSUYbiWImIKFpcdV7+KqEktiQ  (ED25519)
== dev
256 SHA256:87k/k3EyzFKJxLeqM/s4/9DGamKVfI47ObDuy71yEiQ no comment (ED25519)
== stg
256 SHA256:+L8bVR/E3HWvUJekRIKSskKtUA8RgX9irRPIlrhoZMo no comment (ED25519)
== prod
256 SHA256:GMbi9fSgLhSJ025ImKtSUYbiWImIKFpcdV7+KqEktiQ no comment (ED25519)
```

### ■ 結果

5台とも、`authorized_keys`には鍵が2つ入っていました。1つはその環境の鍵で、各環境の秘密鍵から作り直した公開鍵と一致しています。prodの3台は、同じ鍵です。もう1つは、操作する人の鍵（`SHA256:Apv1...`）で、dev・stg・prodの5台すべてに共通でした。

環境ごとの鍵は、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション4で確かめたとおり、別の環境のコンテナには入れません。一方、操作する人の鍵は、1つの秘密鍵で、3つの環境のすべてのコンテナに入れます。環境を分けても、この鍵については、環境の境界がありません。

### 棚卸しの結果

ここまでの結果を、2種類に分けて並べます。「渡っている先」は、値そのものが届く場所です。

パイプラインがツールを動かすための鍵は、次の3つです。

|機密情報|使い道|値がある場所（Gitの外）|渡っている先|
|---|---|---|---|
|接続用の秘密鍵|パイプラインのAnsibleが、その環境のコンテナにSSHで接続する。3環境で1つずつある|各環境のtfstate、手元の`ansible/keys/<環境>/`|「GitOps Pipeline」「GitOps Apply」のジョブの作業ディレクトリ（ジョブの最後に削除）|
|操作する人の鍵|人が手元から、どの環境のコンテナにも接続する|手元の`~/.ssh/id_ed25519`|―（公開鍵が5台すべてに入っている）|
|接続文字列|Terraformが、tfstateのデータベースを読み書きする。承認待ちの記録（`gitops.applied`）も読み書きする|GitHubのSecrets、手元の`backend.env`。同じパスワードが`postgres.env`にもある|「GitOps Pipeline」「GitOps Apply」のすべてのジョブ（プルリクエストの確認を含む）|

操作対象に入れる秘密の値は、次の2つです。

|機密情報|使い道|値がある場所（Gitの外）|渡っている先|
|---|---|---|---|
|`ansible`のパスワード|イメージのビルドで、コンテナの`ansible`ユーザーに設定する|GitHubのSecrets、手元の3環境の`terraform.tfvars`|「GitOps Pipeline」「GitOps Apply」のすべてのジョブ、ホステッドランナーの「Drift Check」「E2E Provisioning Test」|
|`deploy`のパスワード|prodの、どのコンテナも使っていない2つのイメージのビルドで、`deploy`ユーザーに設定する|GitHubのSecrets、手元のprodの`terraform.tfvars`|「GitOps Pipeline」「GitOps Apply」のすべてのジョブ、ホステッドランナーの「Drift Check」「E2E Provisioning Test」|

ジョブごとにGitHubが発行するトークン（`github.token`）も、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** から承認ゲートの入口の確認に使っていますが、人が作って置いておく値ではないため、どちらの表にも入れていません。

棚卸しから分かることは、次の3つです。

1つ目は、1つの値が、Gitの外の複数の場所にあることです。`ansible`のパスワードは、Secretsと手元の3つの変数ファイルに、接続文字列に含まれるデータベースのパスワードは、Secretsと手元の2つのファイルに、接続用の秘密鍵は、tfstateと手元のファイルにあります。値を入れ替えるときは、そのすべてを入れ替える必要があります。

2つ目は、値が、使う場所より広く渡っていることです。3つのSecretsは、ワークフロー全体の`env`で渡しているため、適用をしないプルリクエストの確認のジョブにも届きます。パスワードは、パイプラインの操作対象を扱わないホステッドランナーのワークフローにも渡っています。操作する人の鍵は、1つの鍵で3つの環境に入れます。

3つ目は、分類と、今の渡し方が合っていないものがあることです。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** の役割分担では、OSのユーザーのパスワードは、インフラの中身に設定する鍵として、Ansible Vaultの側に置くものでした。今のパイプラインでは、このパスワードは、Terraformの変数としてイメージのビルドに渡り、イメージの中で設定されています。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション3で、Trivyが`Dockerfile`の`ARG`でパスワードを渡していることを指摘したのは、この部分です。

2つの表の分類と、値がある場所、渡っている先は、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で、どの機密情報をAnsible VaultとGitHub Secretsのどちらに置くかを決めるときの入力にします。

次のセクションでは、Gitの外に置いたこれらの値が、tfstate、保存したplan、イメージに、実際にどう残っているかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 5. Git以外にも機密情報は漏れる

**[セクション4](#4-第2部で残した機密情報を棚卸しする)** で棚卸しした機密情報が、tfstate、保存したplan、イメージに、実際にどう残っているかを、実機で確かめます。ジョブのログは、第2部の結果から整理します。

**[セクション3](#3-非公開リポジトリでも十分ではない理由)** では、Gitに一度入った機密情報は取り除けないことを確かめました。今のパイプラインは、値そのものをGitに置かない形にしています。しかし、Gitに置かなかった値も、パイプラインを動かす途中で、Gitの外のいくつかの場所に書き込まれます。

どの検証も、値そのものは画面に出しません。値がJSONの中の「どこに」入っているかと、件数だけを表示します。

### ■ 検証内容：tfstateに入っている機密情報

3環境のtfstateを、pgバックエンドから`terraform state pull`で取り出します。ファイルには書かず、シェルの変数に入れて調べます。比べる値は、手元の秘密鍵の2行目（鍵の本体の最初の行）と、手元の変数ファイルの`ansible_user_password`の値です。どちらも変数に入れるだけで、表示しません。`jq`の`paths(...)`は、条件に当てはまる値がJSONの中のどこにあるかを、位置だけで表示します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do
  echo "== $e"
  S=$(terraform -chdir=terraform/envs/$e state pull)
  K=$(sed -n '2p' ansible/keys/$e/id_ed25519_generated)
  P=$(sed -n 's/^ansible_user_password *= *"\(.*\)"$/\1/p' terraform/envs/$e/terraform.tfvars)
  echo "password_extracted=$([ -n "$P" ] && echo yes || echo no)"
  echo "key_line_count=$(printf '%s' "$S" | grep -cF "$K") begin_openssh_count=$(printf '%s' "$S" | grep -c 'BEGIN OPENSSH PRIVATE KEY')"
  echo "-- paths containing the private key"
  printf '%s' "$S" | jq -r --arg k "$K" 'paths(type == "string" and contains($k)) | map(tostring) | join(".")'
  echo "-- paths containing the password"
  [ -n "$P" ] && printf '%s' "$S" | jq -r --arg p "$P" 'paths(type == "string" and contains($p)) | map(tostring) | join(".")'
  echo "-- output sensitive flag"
  printf '%s' "$S" | jq -r '.outputs.generated_private_key.sensitive'
  unset S K P
done
```

**▼ 実行結果**

```plaintext
== dev
password_extracted=yes
key_line_count=2 begin_openssh_count=2
-- paths containing the private key
outputs.generated_private_key.value
resources.3.instances.0.attributes.private_key_openssh
-- paths containing the password
outputs.network_name.value
resources.0.instances.0.attributes.network_data.0.network_name
resources.0.instances.0.attributes.networks_advanced.0.name
resources.0.instances.0.attributes.upload.1.file
resources.1.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
resources.1.instances.0.attributes.id
resources.1.instances.0.attributes.name
resources.1.instances.0.attributes.repo_digest
resources.2.instances.0.attributes.name
-- output sensitive flag
true
== stg
（途中省略：devと同じ位置の表示）
-- output sensitive flag
true
== prod
password_extracted=yes
key_line_count=2 begin_openssh_count=2
-- paths containing the private key
outputs.generated_private_key.value
resources.7.instances.0.attributes.private_key_openssh
-- paths containing the password
（途中省略：ネットワークの名前、イメージの名前、uploadのファイルのパスなど、29か所の位置の表示）
-- output sensitive flag
true
```

秘密鍵は、3環境とも2か所に見つかりました。一方、パスワードは、ネットワークの名前、イメージの名前、`upload`のファイルのパスなど、多くの位置が当たっています。`contains`で「その文字列を含む値」を探したため、パスワードと同じ文字列を一部に含む名前まで当たったものです。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5で、ジョブのログの`ansible`という語がパスワードと関係のない箇所まで伏せられたのと、同じことが起きています。この検証環境のパスワードは、検証用に、ログに頻繁に現れる語と同じ値にしています。

そこで、パスワードは、値が完全に一致する位置だけを調べ直します。あわせて、prodの`deploy_user_password`も同じ方法で調べ、位置の番号が何のリソースかも表示します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do
  echo "== $e"
  S=$(terraform -chdir=terraform/envs/$e state pull)
  echo "-- resources"
  printf '%s' "$S" | jq -r '.resources | to_entries[] | "\(.key) \(.value.module // "-") \(.value.type).\(.value.name)"'
  for v in ansible_user_password deploy_user_password; do
    P=$(sed -n "s/^$v *= *\"\(.*\)\"\$/\1/p" terraform/envs/$e/terraform.tfvars)
    [ -z "$P" ] && { echo "-- $v: not in tfvars"; continue; }
    echo "-- paths equal to $v"
    printf '%s' "$S" | jq -r --arg p "$P" 'paths(type == "string" and . == $p) | map(tostring) | join(".")'
  done
  unset S P
done
```

**▼ 実行結果**

```plaintext
== dev
-- resources
0 module.lab_env docker_container.targets
1 module.lab_env docker_image.this
2 module.lab_env docker_network.this
3 module.lab_env tls_private_key.generated
-- paths equal to ansible_user_password
resources.1.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
-- deploy_user_password: not in tfvars
== stg
-- resources
0 module.lab_env docker_container.targets
1 module.lab_env docker_image.this
2 module.lab_env docker_network.this
3 module.lab_env tls_private_key.generated
-- paths equal to ansible_user_password
resources.1.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
-- deploy_user_password: not in tfvars
== prod
-- resources
0 - docker_image.ansible_target_deploy_nopasswd
1 - docker_image.ansible_target_deploy_passwd
2 - docker_image.ansible_target_legacy
3 - docker_network.app_net
4 module.lab_env docker_container.targets
5 module.lab_env docker_image.this
6 module.lab_env docker_network.this
7 module.lab_env tls_private_key.generated
-- paths equal to ansible_user_password
resources.2.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
resources.5.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
-- paths equal to deploy_user_password
resources.0.instances.0.attributes.build.0.build_args.DEPLOY_USER_PASSWORD
resources.1.instances.0.attributes.build.0.build_args.DEPLOY_USER_PASSWORD
```

### ■ 結果

tfstateには、2種類の機密情報が、どちらも平文で入っていました。

|機密情報|tfstateの中の位置|
|---|---|
|Ansibleの接続に使う秘密鍵|`tls_private_key.generated`の属性`private_key_openssh`と、出力`generated_private_key`の`value`|
|`ansible`ユーザーのパスワード|イメージ（dev・stgはモジュールのイメージ、prodはモジュールのイメージと`legacy`のイメージ）の`build`の`build_args`|
|`deploy`ユーザーのパスワード|prodの`deploy_nopasswd`と`deploy_passwd`のイメージの`build_args`|

出力`generated_private_key`の`sensitive`は`true`でしたが、値は同じ出力の`value`に入っています。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で、`sensitive`は表示を隠す印で、tfstateへの保存には関わらないと確かめたとおりです。その確認は、手元のtfstateで、変数を出力した値について行ったものでした。今回は、tfstateを **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** でリモートバックエンドに移した後も同じであること、そしてTerraformが作った秘密鍵と、リソースに渡したパスワードも、リソースの属性として記録されることを確かめています。

パスワードは、Terraformの変数としてはtfstateに保存されませんが、イメージのビルドに渡したことで、リソースの属性として保存されました。機密情報をリソースに渡せば、その値はtfstateに残ります。

pgバックエンドに移したことで、tfstateは手元のファイルではなくなりました。代わりに、データベースに接続できる人は、3環境のtfstateを読めます。**[セクション4](#4-第2部で残した機密情報を棚卸しする)** で確かめたとおり、データベースへの接続文字列は1つで、3環境のスキーマに共通です。つまり、接続文字列が1つ漏れれば、3環境すべての秘密鍵とパスワードが読めることになります。

### ■ 検証内容：保存したplanに入っている機密情報

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション3では、保存したplanのファイルにtfstateの写しが入ることを確かめ、秘密鍵も含まれていると推測していました。devで、承認待ちと同じ形の保存したplanを作り、中を調べます。変更はないため、適用するものは何もありません。planは、本人だけが読めるディレクトリに作り、調べた後に削除します。

planのファイルの中のファイルは、第7回と同じく、Pythonの標準ライブラリで名前と大きさを表示します。中の`tfstate`と`tfstate-prev`はJSONとして調べ、計画そのものである`tfplan`はJSONではないため、秘密鍵の本体の行が現れる回数だけを数えます。最後に、`terraform show -json`で取り出したJSONも調べます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
set -a; . ~/.config/tfstate-backend/backend.env; set +a
mkdir -m 700 ~/gitops13-plans
(umask 077; terraform -chdir=terraform/envs/dev plan -input=false -no-color -out="$HOME/gitops13-plans/tfplan-dev" > /dev/null); echo "plan_exit_code=$?"
ls -la ~/gitops13-plans
python3 -c 'import sys, zipfile; [print(i.file_size, i.filename) for i in zipfile.ZipFile(sys.argv[1]).infolist()]' ~/gitops13-plans/tfplan-dev
export K=$(sed -n '2p' ansible/keys/dev/id_ed25519_generated)
P=$(sed -n 's/^ansible_user_password *= *"\(.*\)"$/\1/p' terraform/envs/dev/terraform.tfvars)
echo "password_extracted=$([ -n "$P" ] && echo yes || echo no)"
for m in tfstate tfstate-prev; do
  M=$(python3 -c 'import sys, zipfile; sys.stdout.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode())' ~/gitops13-plans/tfplan-dev "$m")
  echo "-- zip member $m: paths containing the private key"
  printf '%s' "$M" | jq -r --arg k "$K" 'paths(type == "string" and contains($k)) | map(tostring) | join(".")'
  echo "-- zip member $m: paths equal to ansible_user_password"
  printf '%s' "$M" | jq -r --arg p "$P" 'paths(type == "string" and . == $p) | map(tostring) | join(".")'
done
echo "-- zip member tfplan: private key line count=$(python3 -c 'import os, sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read("tfplan").count(os.environ["K"].encode()))' ~/gitops13-plans/tfplan-dev)"
J=$(terraform -chdir=terraform/envs/dev show -json "$HOME/gitops13-plans/tfplan-dev")
echo "-- terraform show -json: paths containing the private key"
printf '%s' "$J" | jq -r --arg k "$K" 'paths(type == "string" and contains($k)) | map(tostring) | join(".")'
echo "-- terraform show -json: paths equal to ansible_user_password"
printf '%s' "$J" | jq -r --arg p "$P" 'paths(type == "string" and . == $p) | map(tostring) | join(".")'
unset K P M J
rm -r ~/gitops13-plans
ls -ld ~/gitops13-plans; echo "ls_exit_code=$?"
```

**▼ 実行結果**

```plaintext
plan_exit_code=0
total 24
drwx------  2 control control  4096 Oct 15 11:03 .
drwxr-x--- 15 control control  4096 Oct 15 11:03 ..
-rw-------  1 control control 13410 Oct 15 11:03 tfplan-dev
9207 tfplan
11549 tfstate
11512 tfstate-prev
773 tfconfig/m-/main.tf
602 tfconfig/m-/outputs.tf
1194 tfconfig/m-lab_env/main.tf
509 tfconfig/m-lab_env/outputs.tf
704 tfconfig/m-lab_env/variables.tf
146 tfconfig/modules.json
2485 .terraform.lock.hcl
password_extracted=yes
-- zip member tfstate: paths containing the private key
outputs.generated_private_key.value
resources.3.instances.0.attributes.private_key_openssh
-- zip member tfstate: paths equal to ansible_user_password
resources.1.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
-- zip member tfstate-prev: paths containing the private key
outputs.generated_private_key.value
resources.3.instances.0.attributes.private_key_openssh
-- zip member tfstate-prev: paths equal to ansible_user_password
resources.1.instances.0.attributes.build.0.build_args.ANSIBLE_USER_PASSWORD
-- zip member tfplan: private key line count=2
-- terraform show -json: paths containing the private key
planned_values.outputs.generated_private_key.value
planned_values.root_module.child_modules.0.resources.3.values.private_key_openssh
resource_changes.3.change.before.private_key_openssh
resource_changes.3.change.after.private_key_openssh
output_changes.generated_private_key.before
output_changes.generated_private_key.after
prior_state.values.outputs.generated_private_key.value
prior_state.values.root_module.child_modules.0.resources.3.values.private_key_openssh
-- terraform show -json: paths equal to ansible_user_password
variables.ansible_user_password.value
planned_values.root_module.child_modules.0.resources.1.values.build.0.build_args.ANSIBLE_USER_PASSWORD
resource_changes.1.change.before.build.0.build_args.ANSIBLE_USER_PASSWORD
resource_changes.1.change.after.build.0.build_args.ANSIBLE_USER_PASSWORD
prior_state.values.root_module.child_modules.0.resources.1.values.build.0.build_args.ANSIBLE_USER_PASSWORD
ls: cannot access '/home/control/gitops13-plans': No such file or directory
ls_exit_code=2
```

### ■ 結果

第7回で推測していたとおり、保存したplanには、秘密鍵とパスワードが入っていました。

|planの中|秘密鍵|パスワード|
|---|---|---|
|`tfstate`、`tfstate-prev`|それぞれ2か所（tfstateと同じ位置）|それぞれ1か所（イメージの`build_args`）|
|`tfplan`（計画そのもの）|鍵の本体の行が2回現れた|（調べていない）|
|`terraform show -json`で取り出したJSON|8か所|5か所。`variables.ansible_user_password.value`を含む|

`tfstate`と`tfstate-prev`は、計画を作った時点のtfstateの写しなので、tfstateにある機密情報は、すべてplanにも入ります。さらに、`terraform show -json`のJSONには、planを作ったときに渡した変数の値（`variables.ansible_user_password.value`）も入っていました。tfstateにはなかった、変数そのものの値です。

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で、承認待ちのplanを、ワークフローの成果物としてGitHubに上げず、ランナーのホストの本人だけが読めるディレクトリに置くと決めたのは、この中身を外部に預けないためでした。その判断は、この結果で裏付けられます。一方で、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** からは、マージのたびに3環境の承認待ちを作るため、ランナーのホストには、3環境の秘密鍵とパスワードを含むplanが、承認されるか破棄されるまで残ります。

### ■ 検証内容：イメージの履歴に残るパスワード

**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション3では、Trivyが`Dockerfile`の4つのファイルに、`ARG`でパスワードを渡しているという指摘（DS-0031）を出しました。ビルドしたイメージの履歴（`docker history`）に、そのパスワードが残っているかを確かめます。

値は表示しません。履歴の中の`ANSIBLE_USER_PASSWORD=`の後ろを`<masked>`に置き換えてから表示し、値が残っているかどうかは、`=`の後ろが変数ファイルの値と完全に一致する件数で数えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}' | grep -E 'REPOSITORY|ansible-target'
P=$(sed -n 's/^ansible_user_password *= *"\(.*\)"$/\1/p' terraform/envs/dev/terraform.tfvars)
echo "password_extracted=$([ -n "$P" ] && echo yes || echo no)"
for img in ansible-target:ubuntu22.04-dev ansible-target:ubuntu22.04-stg ansible-target:ubuntu22.04; do
  echo "== $img"
  H=$(docker history --no-trunc --format '{{.CreatedBy}}' "$img")
  echo "lines_with_arg_name=$(printf '%s\n' "$H" | grep -c 'ANSIBLE_USER_PASSWORD')"
  echo "values_equal_to_password=$(printf '%s\n' "$H" | grep -o 'ANSIBLE_USER_PASSWORD=[^ ]*' | cut -d= -f2- | grep -cxF "$P")"
  printf '%s\n' "$H" | grep 'ANSIBLE_USER_PASSWORD' | sed 's/ANSIBLE_USER_PASSWORD=[^ ]*/ANSIBLE_USER_PASSWORD=<masked>/g' | cut -c1-160
done
unset P H
```

**▼ 実行結果**

```plaintext
REPOSITORY:TAG                   IMAGE ID       CREATED
ansible-target:ubuntu22.04-dev   339abaa620aa   4 days ago
ansible-target:ubuntu22.04-stg   339abaa620aa   4 days ago
ansible-target:immutable         4749a0ce1054   4 weeks ago
ansible-target:ubuntu22.04       35887767a57b   4 weeks ago
ansible-target:deploy-nopasswd   04afd2e3f7a2   4 weeks ago
ansible-target:deploy-passwd     04afd2e3f7a2   4 weeks ago
ansible-target:ubuntu18.04       a16c62a2699b   6 weeks ago
password_extracted=yes
== ansible-target:ubuntu22.04-dev
lines_with_arg_name=3
values_equal_to_password=3
RUN |1 ANSIBLE_USER_PASSWORD=<masked> /bin/sh -c mkdir -p /home/ansible/.ssh &&     chown -R ansible:ansible /home/ansible/.ssh &&     chmod 700 /home/ansible/.
RUN |1 ANSIBLE_USER_PASSWORD=<masked> /bin/sh -c useradd -m -s /bin/bash ansible &&     echo "ansible:${ANSIBLE_USER_PASSWORD}" | chpasswd &&     echo 'ansible
ARG ANSIBLE_USER_PASSWORD=<masked>
== ansible-target:ubuntu22.04-stg
（途中省略：devと同じ表示）
== ansible-target:ubuntu22.04
lines_with_arg_name=3
values_equal_to_password=3
（途中省略：devと同じ3行の表示）
```

### ■ 結果

3つのイメージとも、履歴の3か所に、パスワードの値がそのまま残っていました（`values_equal_to_password=3`）。`ARG`の行と、`ARG`の値を環境変数として受け取って動いた2つの`RUN`の行です。ユーザーのパスワードを設定する`RUN`だけでなく、`.ssh`のディレクトリを作るだけの`RUN`にも、値が記録されています。

イメージの履歴は、イメージがある限り残り、ホストでDockerを操作できる人なら、`docker history`で読めます。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** のセクション8で確かめたとおり、self-hostedランナーのジョブ（Moleculeのジョブなど）も、このホストのDockerを操作できます。この検証環境のイメージはホストの中だけにありますが、イメージをレジストリに上げる構成では、イメージを取得できる人が、同じ履歴を読めることになります（この経路は、実機では確かめていません）。

また、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション3で、イメージに`ignore_changes = [build]`を付け、`build`の中身を変えてもイメージを作り直さない形にしました。この形では、Secretsや変数ファイルのパスワードを変えても、イメージは作り直されず、古いパスワードが、イメージの履歴とコンテナの中に残り続けることになります（この経路は、第10回の設定からの導出で、実機では確かめていません）。値を入れ替えるときに何を作り直す必要があるかは、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** で扱います。

この回では、モジュールの3つのイメージだけを調べました。`deploy`ユーザーのパスワードを渡している2つのイメージと、`legacy`のイメージ、どのコードからも作られていない`ansible-target:immutable`の履歴は、調べていません。

### ジョブのログ

ジョブのログについては、第2部で次のことを確かめています。

* Secretsに登録した値と一致する文字列は、ログの中で`***`に伏せられる。ただし、この検証環境のパスワードはログに頻繁に現れる語と同じ値のため、関係のない語まで伏せられ、伏せられ方から値を推測できた（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のセクション3）
* `TF_LOG=TRACE`と`-vvv`を有効にしても、数えた機密の値（接続文字列、3環境の秘密鍵）は、ジョブのログに出なかった。秘密鍵は、ファイルとして書き出し、`ansible-playbook`にはパスだけを渡しているためである（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション5）
* ログの伏せ字は、Secretsに登録した値にしか効かない（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション5）

3つ目を、この回の結果と合わせると、伏せ字の届かない値があることが分かります。秘密鍵は、Secretsに登録しておらず、tfstateから取り出しています。保存したplanの中の変数の値や、イメージの履歴の値も、ログに出れば、そのままの形で残ります。ログに値が出ていないのは、今のワークフローの書き方で値を出していないからで、伏せ字が守っているからではありません。

### Git以外の経路のまとめ

ここまでの結果を並べると、次のとおりです。

|経路|入っていたもの|読める人|残る期間|
|---|---|---|---|
|tfstate（pgバックエンド）|3環境の秘密鍵、`ansible`と`deploy`のパスワード|データベースへの接続文字列を持つ人と、それを渡されたジョブ|リソースがある限り|
|保存したplan|秘密鍵、パスワード、planを作ったときの変数の値|ランナーのホストのユーザー|承認待ちの間（適用か破棄で削除）|
|イメージの履歴|パスワード|ホストでDockerを操作できる人（ランナーのジョブを含む）|イメージがある限り|
|ジョブのログ|今のワークフローでは、数えた値は出ていない。伏せ字はSecretsに登録した値にしか効かない|リポジトリを読める人|ログが残っている限り|

機密情報をGitに置かないようにしても、Gitに置かなかった値は、Terraformの記録、計画のファイル、イメージの作り方の記録という形で、Gitの外に書き込まれていました。どれも、パイプラインを動かすために、TerraformやDockerがふつうに作るものです。「Gitに置かなければ安全」とは言えません。

これらの経路を、どう塞ぐかは経路ごとに異なります。復号した値をログや差分に出さない設計は **[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で、tfstateに秘密を残さない設計は **[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で、漏れた値を入れ替える手順は **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** で扱います。

次のセクションでは、機密情報を平文でGitに置かないための2つの選択肢、「Gitに置かない」と「Gitに置くが読めなくする」を位置づけます。

---

[↑ 目次に戻る](#-目次)

---

## 6. Gitに置かないかGitに置くが読めなくするか

機密情報を平文でGitに置かないための2つの選択肢を、ここまでの結果をもとに位置づけます。

機密情報を、平文のままGitに置かない方法は、大きく2つあります。

* **Gitに置かない**：値をGitの外に置き、パイプラインの実行のときに渡す。GitHubのSecretsや、ランナーのホストの上のファイルに置く方法がこれに当たる
* **Gitに置くが読めなくする**：値を暗号化して、暗号文をGitに置く。Ansible Vaultで暗号化してコミットする方法がこれに当たる

第2部のパイプラインは、すべての機密情報を、1つ目の「Gitに置かない」で扱ってきました。

### Gitに置かない

この方法では、値そのものはGitに入りません。**[セクション3](#3-非公開リポジトリでも十分ではない理由)** で確かめた、履歴から取り除けない、クローンのたびに複製される、という性質は、値には及びません。

その代わり、**[セクション2](#2-唯一の真実と機密情報は衝突する)** で整理したとおり、値はGitの仕組みの外に出ます。値を変えても、Gitにコミットは残らず、プルリクエストのレビューも、承認ゲートの入口の確認も通りません。「Gitが唯一の真実」と言える範囲から、値が外れることになります。また、**[セクション4](#4-第2部で残した機密情報を棚卸しする)** で確かめたとおり、1つの値が、Secretsと手元の複数のファイルのように、Gitの外のいくつもの場所に置かれていました。どこに置いたかは、Gitを見ても分かりません。

### Gitに置くが読めなくする

この方法では、値は暗号文としてGitに入ります。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で確かめたとおり、Ansible Vaultで暗号化したファイルは、正しいVaultパスワードがなければ復号できません。

値の変更は、暗号文を書き換えるコミットになります。そのため、値の変更も、Gitの履歴に残り、プルリクエストと承認ゲートを通ります。値をGitの仕組みの中に置いたまま、平文では置かない、という形です。「Gitが唯一の真実」と言える範囲に、機密情報を戻せることになります。

一方で、この方法には、新しい問題が2つあります。

1つ目は、復号の鍵であるVaultパスワードの置き場所です。Vaultパスワードを、同じリポジトリに平文で置けば、暗号化した意味がなくなります。Vaultパスワードは、結局、Gitの外に置くことになります。機密情報をGitに入れる代わりに、それを開く1つの鍵を、Gitの外で守ることになります。

2つ目は、暗号文も、**[セクション3](#3-非公開リポジトリでも十分ではない理由)** の性質を持つことです。暗号文は、履歴に残り、クローンのたびに複製されます。Vaultパスワードが漏れれば、今の暗号文だけでなく、履歴に残った過去の暗号文も、すべての複製で読めることになります。

### どちらを選んでも、Gitの外の経路は残る

2つの選択肢が決めるのは、値をどこに保管するかです。**[セクション5](#5-git以外にも機密情報は漏れる)** で確かめた経路は、保管の場所ではなく、値の渡し方で生まれていました。

たとえば、ユーザーのパスワードをAnsible Vaultで暗号化してGitに置いても、今のパイプラインのように、復号した値をTerraformの変数としてイメージのビルドに渡せば、値はtfstateと、保存したplanと、イメージの履歴に残ります。Vaultで暗号化することは、Gitの中の値を守りますが、復号した後の値がどこに書き込まれるかは守りません。

|観点|Gitに置かない|Gitに置くが読めなくする|
|---|---|---|
|Gitの履歴と複製|値は入らない|暗号文が入る。復号の鍵が漏れれば、過去の分も読める|
|値の変更の記録とレビュー|Gitに残らず、レビューも承認も通らない|コミットとして残り、プルリクエストと承認ゲートを通る|
|守るべき鍵|それぞれの値そのもの|復号の鍵（Vaultパスワード）。これはGitの外に置く|
|Gitの外の経路（tfstate、plan、イメージ、ログ）|値の渡し方しだいで残る|復号した値の渡し方しだいで残る|

### 選び方の手がかりは、セクション4の分類にある

どちらを選ぶかは、機密情報ごとに決めます。その手がかりになるのが、**[セクション4](#4-第2部で残した機密情報を棚卸しする)** の分類です。

パイプラインがツールを動かすための鍵は、パイプラインがGitのリポジトリを取得し、TerraformやAnsibleを動かし始めるときに、すでに必要なものです。tfstateのデータベースへの接続文字列がなければ、Terraformは初期化できません。Vaultパスワードも、この種類の鍵に加わります。

操作対象に入れる秘密の値は、操作対象の設定と一緒に変わるものです。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** の役割分担では、インフラの中身に設定する鍵は、Ansible Vaultの側に置くものでした。

その秘密が、何と一緒に変わり、いつ、何のために必要になるかによって、置き場所は決まります。この判断の基準と、機密情報ごとの役割分担は、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で確定させます。その前に、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** では、「Gitに置くが読めなくする」選択肢として、Ansible VaultをGitOpsのパイプラインで扱い、Vaultパスワードの渡し方と、復号した値をログや差分に出さない設計を扱います。

次のセクションでは、ここまでの分類と経路が、AWSやGCPのプロバイダーでも同じように当てはまることを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. クラウドプロバイダーでも分類と経路は同じ

この回で整理した機密情報の分類と、Git以外の経路が、TerraformのプロバイダーをAWSやGCPに切り替えたときに、どこが変わり、どこが変わらないかを整理します。クラウドでの実行は行っていないため、ここでは、第2部までに整理した対応と、この回の結果を並べて比べます。

### 「ツールを動かすための鍵」に、クラウドの認証情報が加わる

この検証環境で、パイプラインのTerraformがDockerのリソースを操作するのに、認証情報は渡していません。Terraformは、ランナーのホストのDockerを、ホストのユーザーの権限で操作しています。**[セクション4](#4-第2部で残した機密情報を棚卸しする)** の棚卸しに、Terraformがリソースを操作するための鍵が出てこなかったのは、このためです。

クラウドでは、Terraformがクラウドのリソースを操作するために、クラウドの認証情報が必要になります。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション7と、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション8で、クラウドの認証情報が外部に預けるものに加わると整理したとおりです。この認証情報は、パイプラインがツールを動かすための鍵に分類され、その権限の範囲で、仮想マシンもネットワークもデータベースも、作ることも消すこともできます。漏れたときの影響は、この回で棚卸しした機密情報の中で、最も大きくなります。

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** のセクション6では、環境ごとにアカウントやプロジェクトを分けるクラウドの構成では、devの実行にprodの権限を渡さないよう、環境ごとに別の認証情報を渡す必要があると整理しました。**[セクション4](#4-第2部で残した機密情報を棚卸しする)** で、この検証環境では、データベースへの接続文字列が1つで3環境に共通だったことと、同じ問題です。

### 分類と経路の対応

この回の機密情報と経路を、AWSとGCPに当てはめると、次のとおりです。

|この回で扱ったもの|Docker（この検証環境）|AWS・GCP|
|---|---|---|
|Terraformがリソースを操作するための鍵|なし（ホストのユーザーの権限でDockerを操作する）|クラウドの認証情報。ツールを動かすための鍵として加わる|
|tfstateの置き場所への接続|pgバックエンドの接続文字列|S3やGCSのバックエンドを読み書きするための、クラウドの認証情報|
|Ansibleの接続に使う鍵|`tls_private_key`で作り、`upload`で公開鍵を配る|同じ`tls_private_key`で作れる。公開鍵は、AWSでは`aws_key_pair`、GCPではインスタンスのメタデータ（`ssh-keys`）で配る（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）|
|操作対象に入れる秘密の値|イメージのビルドの`build_args`で渡した|マシンイメージ、起動時の初期設定（`user_data`、起動スクリプト）、Ansibleのどれで入れるかを選ぶ（**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション6）|

分類そのものは変わりません。ツールを動かすための鍵が1つ増え、操作対象に入れる秘密の値を渡す手段の名前が変わるだけです。

### tfstateに残る構造は、バックエンドを問わない

**[セクション5](#5-git以外にも機密情報は漏れる)** で、秘密鍵は`tls_private_key`の属性として、パスワードはイメージのリソースの属性として、tfstateに入っていました。`tls_private_key`はプロバイダーに依存しないリソースなので、クラウドでも、同じ秘密鍵が同じ形でtfstateに入ります。

tfstateをS3やGCSのバックエンドに置いても、tfstateの中身は変わりません。tfstateの置き場所を変えて変わるのは、誰がそれを読めるかで、そこに何が書かれているかではありません。読める人は、バックエンドへのアクセスの権限で決まります。

また、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション6で触れたとおり、S3とGCSのバックエンドの公式ドキュメントでは、誤って削除したときに戻せるよう、バケットのバージョニングを有効にすることが強く推奨されています。バージョニングを有効にすれば、tfstateの過去の版も残ります。過去の版には、その時点の秘密鍵やパスワードが入っています。**[セクション3](#3-非公開リポジトリでも十分ではない理由)** で、Gitの履歴から機密情報を取り除けなかったのと同じ構造が、tfstateの側にも生まれることになります（この経路は、バージョニングの仕組みからの導出で、実機では確かめていません）。

操作対象に入れる秘密の値を、`user_data`などのリソースの属性として渡した場合に、その値がtfstateにどう記録されるかは、プロバイダーと属性によって異なりえます。この回では確かめていません。**[セクション5](#5-git以外にも機密情報は漏れる)** と同じ方法で、`terraform state pull`の結果から、値がどこに入っているかを確かめる必要があります。

### 保存したplan、イメージ、ジョブのログ

残りの3つの経路も、構造は変わりません。

* **保存したplan**：planのファイルにtfstateの写しが入るのは、Terraformの仕組みで、プロバイダーに関係しない。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション8で整理したとおり、ランナーを実行のたびに作り直す構成では、承認待ちのplanの置き場所を別に用意することになり、その置き場所は、planに機密情報が入ることを前提に選ぶ必要がある
* **イメージ**：マシンイメージを作る段階で秘密の値を渡せば、イメージの側に値が残りうるという構造は同じである。どこに、どういう形で残るかは、イメージを作るツールによる（この回では確かめていない）
* **ジョブのログ**：GitHub Actionsの伏せ字が、Secretsに登録した値にしか効かないことは、プロバイダーに関係しない。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション7で整理したとおり、`TF_LOG=TRACE`で出る内容は、クラウドではクラウドのAPIとのやり取りになる

### 長期間有効な鍵を、外部に預けない設計

クラウドでは、ツールを動かすための鍵を、どれだけの期間有効にするかも問題になります。長期間有効なクラウドの認証情報をGitHubのSecretsに置けば、その鍵は、外部の事業者の上に置かれ続けます。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6では、外部に預ける範囲を狭める設計として、長期間有効なクラウドの認証情報をSecretsに置かずに済ませる方法があることに触れました。この設計は、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で扱います。

プロバイダーを切り替えて変わるのは、ツールを動かすための鍵の中身と、その鍵を誰に、どの範囲で、どれだけの期間持たせるかです。機密情報を「ツールを動かすための鍵」と「操作対象に入れる秘密の値」に分けること、Gitに置かなかった値が、tfstate、保存したplan、イメージ、ジョブのログという、Gitの外の経路に残りうることは、プロバイダーを問わず同じです。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* GitOpsの考え方は、インフラのあるべき状態を決める「決めたこと」をGitに置くことを求めるが、ユーザーのパスワードやtfstateへの接続文字列のような機密情報は、決めたことであっても平文では置けない。今のパイプラインは、値をGitの外に置き、Gitには値をどこから受け取り、どこへ渡すかという手順だけを置いている。Gitの外に置いた値は、変更の履歴、プルリクエストのレビュー、承認ゲートの入口の確認という、Gitの仕組みの外にある
* ダミーの機密情報を含むファイルをコミットし、次のコミットで削除しても、過去のコミットを指定すれば中身を取り出せ、コミットもファイル名も指定せずに文字列だけで探しても見つかることを実機で確認した。クローンした先にも履歴ごとついてきて、ブランチを削除した後も、手元のリポジトリにコミットが残っていた。リポジトリを非公開にすることは、読める人を限るが、一度入った機密情報を取り除く効果はない
* 第2部で残した機密情報を、パイプラインがツールを動かすための鍵（Ansibleの接続に使う秘密鍵、操作する人の鍵、tfstateのデータベースへの接続文字列）と、操作対象に入れる秘密の値（`ansible`と`deploy`のユーザーのパスワード）に分けて棚卸しした。1つの値がGitの外の複数の場所にあり、Secretsはプルリクエストの確認のジョブやホステッドランナーにも渡り、操作する人の鍵は1つで3つの環境に入れた。ユーザーのパスワードは、分類としてはインフラの中身に設定する値だが、Terraformの変数としてイメージのビルドに渡っている
* tfstateには、3環境の秘密鍵が`tls_private_key`の属性と出力の値の2か所に、パスワードがイメージのリソースの`build_args`に、平文で入っていることを実機で確認した。出力の`sensitive`は`true`でも、値は同じ場所に入っている。データベースへの接続文字列は3環境に共通で、1つ漏れれば3環境すべての秘密鍵とパスワードが読める
* 保存したplanには、tfstateの写しである`tfstate`と`tfstate-prev`、計画そのものの`tfplan`のどれにも秘密鍵が入っていることを実機で確認し、第7回で推測のまま残した点を確かめた。`terraform show -json`のJSONには、planを作ったときに渡した変数の値も入っていた
* ビルドしたイメージの履歴には、`ARG`で渡したパスワードの値が、`ARG`の行と、それを使った2つの`RUN`の行の3か所に、そのまま残っていることを実機で確認した。イメージの履歴は、ホストでDockerを操作できる人なら読める
* ジョブのログの伏せ字は、Secretsに登録した値にしか効かない。今のワークフローで機密の値がログに出ていないのは、値を出さない書き方をしているからで、伏せ字が守っているからではない。パスワードがログに頻繁に現れる語と同じ値だと、伏せ方から値を推測でき、tfstateの中を文字列で探したときも、関係のない値まで当たった
* 機密情報を平文でGitに置かない方法には、「Gitに置かない」と「Gitに置くが読めなくする」の2つがある。前者は値がGitの仕組みの外に出て、後者は値をGitの仕組みの中に戻せるが、復号の鍵をGitの外で守る必要がある。どちらを選んでも、値の渡し方しだいで、Gitの外の経路には残る。選び方の手がかりは、ツールを動かすための鍵か、操作対象に入れる秘密の値かという分類にある
* クラウドでは、ツールを動かすための鍵にクラウドの認証情報が加わり、漏れたときの影響が最も大きい機密情報になる。tfstateに機密情報が残る構造は、S3やGCSのバックエンドでも変わらない。機密情報の分類と、Gitの外の経路は、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

本シリーズの **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** では、パイプラインの失敗を4つの層に分け、設計どおりの停止と故障を見分ける方法を整理して、第2部を終えました。第13回となる今回は、第3部の初回として、「あるべき状態をすべてGitに置く」GitOpsの考え方と、Gitに平文で置けない機密情報が、どこでぶつかるのかを整理しました。リポジトリを非公開にしても、一度コミットした機密情報は、削除しても、クローンしても、ブランチを消しても残ることを実機で確認しました。そのうえで、第2部で暫定のまま残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値に分けて棚卸しし、tfstate、保存したplan、イメージの履歴、ジョブのログという、Gitに置かなかった値が残る経路を確かめました。最後に、「Gitに置かない」と「Gitに置くが読めなくする」の2つの選択肢を位置づけ、この構造がクラウドのプロバイダーでも変わらないことを整理しました。

今回から、第3部「GitOpsパイプラインでの機密情報管理」に入りました。第3部では、この回で棚卸しした機密情報を、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** までに、GitOpsのパイプラインの中で扱える形にしていきます。

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** では、「Gitに置くが読めなくする」選択肢として、Ansible VaultをGitOpsのパイプラインで扱います。この回で整理したとおり、Ansible Vaultを使うと、機密情報をGitの仕組みの中に戻せる一方で、復号の鍵であるVaultパスワードを、Gitの外で守る必要が生まれます。また、復号した値は、渡し方しだいでGitの外の経路に残ります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で承認の材料にした`--diff`は、書き込む内容をそのままログに出します。次回は、Vaultパスワードをパイプラインにどう渡すか、暗号化の単位とレビューのしやすさをどう両立させるか、復号した値をジョブのログや差分にどう出さないかという3つの問題を、パイプラインの設計で塞ぎます。

**[次回：第14回：Ansible VaultをGitOpsパイプラインで安全に扱う](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)　｜　[次の記事：【GitOps編】第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**

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
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**|Ansible VaultをGitOpsパイプラインで安全に扱う|Vaultパスワードの渡し方、暗号化の単位とレビューのしやすさ、復号後の値のログ・差分への露出という3つの問題をパイプラインの設計で塞ぐ。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**|Ansible VaultとGitHub Secretsの役割分担|「その秘密が何と一緒に変わるか」というライフサイクルを基準に、「Gitの中はVault、Gitの外は鍵」の役割分担を確定させる。誤用パターン、tfstateに秘密を残さない設計、無料プランでの分離の限界、長期間有効な鍵を外部に預けない設計（OIDC等）も扱う。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**|Vault情報が漏洩・破損した場合の復旧設計|漏洩と破損を分け、GitHub Secretsが読み出せないこと、Vaultパスワードの変更では過去の暗号文を守れないことを示す。秘密の値そのものの入れ替えをパイプラインに通し、Vault IDで段階的に切り替える。入れ替えのコミットをrevertしてはいけない理由を第11回と接続する。第3部の最終回。|

---

[↑ 目次に戻る](#-目次)

---