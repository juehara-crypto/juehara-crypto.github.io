---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第38回：インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成'
description: 'terraform-docsを用いてTerraformコードからMarkdown形式の仕様書を自動生成し、Ansible Role側のドキュメント化とあわせて、コードとドキュメントの乖離という運用課題への対処を整理する。'
pubDate: 2026-09-04
category: 'infra'
tags: ['Ansible', 'Terraform', 'terraform-docs', 'ドキュメント自動生成', 'CI/CD']
seriesId: 'ansible-terraform-part4'
seriesNo: 38
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/'
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
2. [手動ドキュメントがコードから乖離していく構造](#2-手動ドキュメントがコードから乖離していく構造)
3. [terraform-docsの基本的な使い方](#3-terraform-docsの基本的な使い方)
4. [第35回のModuleへの適用](#4-第35回のmoduleへの適用)
5. [コード変更への追従](#5-コード変更への追従)
6. [Ansible Role側のドキュメント化](#6-ansible-role側のドキュメント化)
7. [自動生成で担保できる範囲と人間が書く範囲の切り分け](#7-自動生成で担保できる範囲と人間が書く範囲の切り分け)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---


## 1. はじめに

`modules/ansible_target_image`や`roles/common_setup`の内部で、どんな変数を受け取り何を行っているかを把握するには、コードを直接読む必要があることに気づいたことはないでしょうか。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、パイプラインの実行順序、検証、コード構造の共通化、待ち時間の削減、変化の検知と自動収束という、コードの「動かし方」を中心に改善を重ねてきました。第38回となる今回は視点を変え、コードそのものの「説明のしかた」を扱います。

**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** で共通化したTerraform ModuleとAnsible Roleは、再利用しやすくなった一方で、その内部の変数や処理内容を把握するには、コードそのものを読むしかない状態のままでした。

問いは、「手動で書いたドキュメントの代わりに、コードから仕様書を機械的に生成する場合、何が自動化され、何は依然として人間が書く必要があるのか」です。

次のセクションでは、この回で解決する課題を具体的に確認します。

---

[↑ 目次に戻る](#-目次)

---


## 2. 手動ドキュメントがコードから乖離していく構造

この回で解決する課題を、実際のコードで確認します。

**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** で作成した`modules/ansible_target_image`について、README等に手動で仕様を書いた場合を想定します。

* **ファイル名：`README.md`（手動管理を想定した例）**

```markdown
## modules/ansible_target_image

### 変数
- image_name: イメージ名
- dockerfile: 参照するDockerfile
- build_args: ビルド時に渡す引数
```

この状態で、`modules/ansible_target_image/variables.tf`に変数を1つ追加します。

### ■ 検証内容：`variables.tf`への変数追加

**実行コマンド**

```plaintext
cat -n modules/ansible_target_image/variables.tf
```

**▼ 実行結果**

```plaintext
variable "image_name" {
  type = string
}

variable "dockerfile" {
  type = string
}

variable "build_args" {
  type = map(string)
}
```

`docker_image`リソースが持つ`keep_locally`（イメージ削除時にローカルのイメージを保持するかどうか）という属性は、Module化の時点では変数化されておらず、固定の挙動のままになっていました。この属性を`variables.tf`に追加します。

**実行コマンド**

```plaintext
cat >> modules/ansible_target_image/variables.tf << 'EOF'

variable "keep_locally" {
  type        = bool
  description = "イメージ削除時にローカルのDockerイメージを保持するかどうか"
  default     = false
}
EOF
```

**▼ 実行結果**

```plaintext
variable "image_name" {
  type = string
}

variable "dockerfile" {
  type = string
}

variable "build_args" {
  type = map(string)
}

variable "keep_locally" {
  type        = bool
  description = "イメージ削除時にローカルのDockerイメージを保持するかどうか"
  default     = false
}
```

### ■ 結果

`variables.tf`に`keep_locally`が追加されましたが、手動管理を想定したREADME側は更新していません。この状態では、README側に`keep_locally`という変数は存在しないままになります。この乖離が積み重なると、README側を見て作業した結果と、実際の`variables.tf`の内容が食い違う事態につながります。

あわせて、既存の3変数（`image_name`・`dockerfile`・`build_args`）には、そもそも`description`が付与されていません。README側の説明文がコード側のどこにも対応しておらず、コードとドキュメントの結びつきが最初から存在しない状態であることも確認できます。

---

[↑ 目次に戻る](#-目次)

---

## 3. terraform-docsの基本的な使い方

この回で導入する仕組みを確認します。

`terraform-docs`は、`.tf`ファイル内の`variable`ブロック・`output`ブロックを読み取り、Markdownテーブル形式の仕様書として出力するツールです。基本的な実行コマンドは以下の形式です。

```plaintext
terraform-docs markdown table <対象ディレクトリ>
```

`variable`ブロックのうち、出力に反映されるのは主に`description`・`type`・`default`の3つのフィールドです。

```hcl
variable "example" {
  type        = string
  description = "このように書いた説明文がテーブルに反映される"
  default     = "sample"
}
```

上記のような`variable`ブロックに対して`terraform-docs markdown table`を実行すると、以下のようなMarkdownテーブルが出力されます。

```plaintext
| Name | Description | Type | Default | Required |
|------|-------------|------|---------|----------|
| example | このように書いた説明文がテーブルに反映される | string | "sample" | no |
```

一方、`description`が書かれていない`variable`ブロックの場合、`Description`列は空欄のまま出力されます。

```hcl
variable "example" {
  type = string
}
```

```plaintext
| Name | Description | Type | Default | Required |
|------|-------------|------|---------|----------|
| example |  | string | n/a | yes |
```

`terraform-docs`はコード側に書かれた情報をそのまま抽出して整形するツールであり、`description`を書いていない変数については、空欄のテーブル行が出力されます。次のセクションでは、この仕組みを`modules/ansible_target_image`に対して実際に適用し、出力結果を確認します。

---

[↑ 目次に戻る](#-目次)

---



## 4. 第35回のModuleへの適用

具体的な実行結果を確認します。

**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** で作成した`modules/ansible_target_image`に対して、実際に`terraform-docs markdown table`を実行します。

### ■ 検証内容：`modules/ansible_target_image`に対する`terraform-docs`の実行

**実行コマンド**

```plaintext
terraform-docs markdown table ./modules/ansible_target_image
```

**▼ 実行結果**

```plaintext
## Requirements
| Name | Version |
|------|---------|
| <a name="requirement_docker"></a> [docker](#requirement\_docker) | ~> 3.0.0 |
## Providers
| Name | Version |
|------|---------|
| <a name="provider_docker"></a> [docker](#provider\_docker) | ~> 3.0.0 |
## Modules
No modules.
## Resources
| Name | Type |
|------|------|
| [docker_image.this](https://registry.terraform.io/providers/kreuzwerker/docker/latest/docs/resources/image) | resource |
## Inputs
| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_build_args"></a> [build\_args](#input\_build\_args) | n/a | `map(string)` | n/a | yes |
| <a name="input_dockerfile"></a> [dockerfile](#input\_dockerfile) | n/a | `string` | n/a | yes |
| <a name="input_image_name"></a> [image\_name](#input\_image\_name) | n/a | `string` | n/a | yes |
| <a name="input_keep_locally"></a> [keep\_locally](#input\_keep\_locally) | イメージ削除時にローカルのDockerイメージを保持するかどうか | `bool` | `false` | no |
## Outputs
| Name | Description |
|------|-------------|
| <a name="output_image_id"></a> [image\_id](#output\_image\_id) | n/a |
```

### ■ 結果

`Inputs`セクションを見ると、`build_args`・`dockerfile`・`image_name`の3変数は`Description`列が`n/a`となっている一方、セクション2で追加した`keep_locally`のみ、`variables.tf`に書いた`description`の内容がそのまま反映されています。`description`を書かなかった変数は、自動生成後も空欄の情報しか得られません。

あわせて、`Requirements`・`Providers`・`Resources`・`Outputs`という、セクション3で示した最小限の例には含まれていなかった項目まで、`terraform-docs`側で自動的に生成されていることも確認できます。`Outputs`の`image_id`についても、`outputs.tf`側に説明文を書いていないため`Description`列は`n/a`のままです。

`variable`ブロック・`output`ブロックにどれだけ丁寧な情報を書くかが、そのまま自動生成される仕様書の充実度に直結する構造が、実際の出力から確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 5. コード変更への追従

自動生成の効果を確認します。

`modules/ansible_target_image/variables.tf`に、新たに`force_remove`変数を追加します。

### ■ 検証内容：変数追加後における`terraform-docs`の再実行

**実行コマンド**

```plaintext
cat >> modules/ansible_target_image/variables.tf << 'EOF'

variable "force_remove" {
  type        = bool
  description = "イメージ削除時に、参照されていても強制的に削除するかどうか"
  default     = false
}
EOF
```

**実行コマンド**

```plaintext
cat -n modules/ansible_target_image/variables.tf
```

**▼ 実行結果**

```plaintext
variable "image_name" {
  type = string
}

variable "dockerfile" {
  type = string
}

variable "build_args" {
  type = map(string)
}

variable "keep_locally" {
  type        = bool
  description = "イメージ削除時にローカルのDockerイメージを保持するかどうか"
  default     = false
}

variable "force_remove" {
  type        = bool
  description = "イメージ削除時に、参照されていても強制的に削除するかどうか"
  default     = false
}
```

続けて`terraform-docs`を再実行し、今度は出力を`README.md`ファイルとして保存します。

**実行コマンド**

```plaintext
terraform-docs markdown table ./modules/ansible_target_image > modules/ansible_target_image/README.md
cat modules/ansible_target_image/README.md
```

**▼ 実行結果**

```plaintext
## Requirements
| Name | Version |
|------|---------|
| <a name="requirement_docker"></a> [docker](#requirement\_docker) | ~> 3.0.0 |
## Providers
| Name | Version |
|------|---------|
| <a name="provider_docker"></a> [docker](#provider\_docker) | ~> 3.0.0 |
## Modules
No modules.
## Resources
| Name | Type |
|------|------|
| [docker_image.this](https://registry.terraform.io/providers/kreuzwerker/docker/latest/docs/resources/image) | resource |
## Inputs
| Name | Description | Type | Default | Required |
|------|-------------|------|---------|:--------:|
| <a name="input_build_args"></a> [build\_args](#input\_build\_args) | n/a | `map(string)` | n/a | yes |
| <a name="input_dockerfile"></a> [dockerfile](#input\_dockerfile) | n/a | `string` | n/a | yes |
| <a name="input_force_remove"></a> [force\_remove](#input\_force\_remove) | イメージ削除時に、参照されていても強制的に削除するかどうか | `bool` | `false` | no |
| <a name="input_image_name"></a> [image\_name](#input\_image\_name) | n/a | `string` | n/a | yes |
| <a name="input_keep_locally"></a> [keep\_locally](#input\_keep\_locally) | イメージ削除時にローカルのDockerイメージを保持するかどうか | `bool` | `false` | no |
## Outputs
| Name | Description |
|------|-------------|
| <a name="output_image_id"></a> [image\_id](#output\_image\_id) | n/a |
```

### ■ 結果

`Inputs`セクションに`force_remove`の行が自動的に追加され、`keep_locally`と同様に`description`の内容がそのまま反映されています。テーブル内の行はアルファベット順（`build_args`・`dockerfile`・`force_remove`・`image_name`・`keep_locally`）に並んでおり、追加した順序ではなく変数名順で整列される点も確認できます。

`README.md`を手動で編集する作業は一切発生していません。`variables.tf`に変数を追加し、`terraform-docs`を再実行するだけで、ドキュメント側が自動的に追従しました。セクション2で確認した「手動ドキュメントの乖離」という課題に対し、コード自体を単一の情報源として扱う運用が、実機で成立することが確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 6. Ansible Role側のドキュメント化

TerraformとAnsibleの非対称性を確認します。

`terraform-docs`はTerraform専用のツールであり、AnsibleのRole（`roles/common_setup`）には適用できません。Ansible側で同様の仕組みを探すと、`ansible-autodoc`というツールが見つかります。まずインストールを試みます。

### ■ 検証内容：`ansible-autodoc`のインストールと実行確認

**実行コマンド**

```plaintext
pip install ansible-autodoc --break-system-packages
ansible-autodoc -h
```

**▼ 実行結果**

```plaintext
Collecting ansible-autodoc
  Downloading ansible_autodoc-0.5.3-py3-none-any.whl.metadata (5.7 kB)
Requirement already satisfied: jinja2 in /home/control/ansible-env/lib/python3.10/site-packages (from ansible-autodoc) (3.1.6)
Requirement already satisfied: pyyaml in /home/control/ansible-env/lib/python3.10/site-packages (from ansible-autodoc) (6.0.3)
Requirement already satisfied: MarkupSafe>=2.0 in /home/control/ansible-env/lib/python3.10/site-packages (from jinja2->ansible-autodoc) (3.0.3)
Downloading ansible_autodoc-0.5.3-py3-none-any.whl (28 kB)
Installing collected packages: ansible-autodoc
Successfully installed ansible-autodoc-0.5.3
usage: ansible-autodoc [project_directory] [options]
Generate documentation from annotated playbooks and roles using templates
positional arguments:
  project_dir           Project directory to scan, if empty current working will be used.
options:
  -h, --help            show this help message and exit
  -C [CONF], --conf [CONF]
                        specify an configuration file
  -o OUTPUT             Define the destination folder of your documenation
  -y                    overwrite the output without asking
  -D, --dry             Dry runt without writing
  --sample-config       Print the sample configuration yaml file
  -p [P]                use print template instead of writing to files, sections: all, info, tags, todo, var
  -V, --version         Get versions
  -v                    Set debug level to info
  -vv                   Set debug level to debug
  -vvv                  Set debug level to trace
```

インストール自体は成功しました。続けて、`roles/common_setup`に対して実際に実行します。

**実行コマンド**

```plaintext
ansible-autodoc -p all roles/common_setup
```

**▼ 実行結果**

```plaintext
Traceback (most recent call last):
  File "/home/control/ansible-env/bin/ansible-autodoc", line 6, in <module>
    doc = AnsibleAutodoc()
  File "/home/control/ansible-env/lib/python3.10/site-packages/ansibleautodoc/AutodocCli.py", line 21, in __init__
    doc_parser = Parser()
  File "/home/control/ansible-env/lib/python3.10/site-packages/ansibleautodoc/DocumentationParser.py", line 34, in __init__
    self._populate_doc_data()
  File "/home/control/ansible-env/lib/python3.10/site-packages/ansibleautodoc/DocumentationParser.py", line 42, in _populate_doc_data
    self._annotation_objs[annotaion] = Annotation(name=annotaion, files_registry=self._files_registry)
  File "/home/control/ansible-env/lib/python3.10/site-packages/ansibleautodoc/Annotation.py", line 90, in __init__
    self._find_tags()
  File "/home/control/ansible-env/lib/python3.10/site-packages/ansibleautodoc/Annotation.py", line 275, in _find_tags
    data = yaml.load(yaml_file)
TypeError: load() missing 1 required positional argument: 'Loader'
```

### ■ 結果

`ansible-autodoc`は実行時にエラーで停止しました。`roles/common_setup`側のコード内容以前に、ツール自体が起動できていません。

エラー内容は、`ansible-autodoc`内部で`yaml.load(yaml_file)`という呼び出しが、`Loader`引数を指定せずに行われていることによるものです。`PyYAML`は`6.0`で破壊的変更を行い、`yaml.load()`実行時に`Loader`引数を明示的に指定することを必須としました。この検証環境には`PyYAML 6.0.3`がインストールされていますが、`ansible-autodoc`（最新版0.5.3を含む）のコードはこの変更に追従できておらず、現行の`PyYAML`とは組み合わせて動作しません。

`terraform-docs`はGo製の単一バイナリとして配布され、Terraform本体のエコシステムの変化と歩調を合わせて更新が続けられています。一方の`ansible-autodoc`は、依存先のPythonライブラリ（`PyYAML`）の破壊的変更に追従できておらず、現行の標準的な環境では実行そのものが成立しません。この回で扱う「TerraformとAnsibleでドキュメント生成の仕組みが統一されていない」という論点は、単にツールの設計思想が異なるという水準にとどまらず、Ansible側では実行可能な選択肢自体が現状乏しいという、より根本的な差として実機で確認されました。

---

[↑ 目次に戻る](#-目次)

---

## 7. 自動生成で担保できる範囲と人間が書く範囲の切り分け

この回の締めくくりとして、自動化の実態を整理します。

Terraform側で確認できた範囲と、Ansible側で確認できた範囲を分けて整理します。

|区分|Terraform（`terraform-docs`）|Ansible（`ansible-autodoc`）|
|---|---|---|
|自動生成できる|変数名・型・デフォルト値・必須かどうか|実行不能のため確認できず|
|人間が書く必要がある|`description`の文言そのもの、なぜこのModuleが必要か、どういう場面で使うか|Role全体の説明を、README等に手動で書く以外の選択肢が実質的にない|

Terraform側は、`variable`ブロックに`description`を書いておけば、それがそのままMarkdownテーブルに反映される仕組みが機能していました。`description`を書かなかった`image_name`・`dockerfile`・`build_args`は空欄のまま出力され、`description`を書いた`keep_locally`・`force_remove`は説明文まで含めて出力されました。自動生成できる範囲（変数の一覧・型・デフォルト値）と、人間が書く必要がある範囲（`description`の文言、Module自体の設計意図）の境界は明確でした。

Ansible側は、この境界を確認する以前の段階でつまずきました。`ansible-autodoc`が動作しないため、`roles/common_setup`のドキュメント化は、現時点では`README.md`を人間が手動で書く以外の方法がありません。これは「自動化できる範囲が狭い」という程度の話ではなく、「この検証環境では自動化の入り口にすら立てなかった」という結果です。

Terraform側で確認できた「コードを単一の情報源として扱う」という運用は、Ansible側では今回試したツールの限りでは成立しませんでした。ドキュメントの自動生成という取り組み自体が、ツールの選定とその保守状況に大きく左右されることが、この回の実機検証を通じて確認できました。

---

[↑ 目次に戻る](#-目次)

---


## 8. まとめ

この回で整理した内容を確認します。

* `modules/ansible_target_image`の`variables.tf`に`description`を書いた変数（`keep_locally`・`force_remove`）は、`terraform-docs markdown table`実行時にその説明文がそのままMarkdownテーブルに反映されることを実機で確認した
* `description`を書いていない変数（`image_name`・`dockerfile`・`build_args`）は、自動生成後も`Description`列が空欄のままであることを実機で確認した
* `variables.tf`に変数を1つ追加し`terraform-docs`を再実行するだけで、`README.md`側が手動編集なしに追従することを実機で確認した
* `ansible-autodoc`はインストール自体には成功したが、`roles/common_setup`に対する実行時にエラーで停止し、この検証環境では動作しなかった
* エラーの原因は、`PyYAML 6.0`の`Loader`引数必須化という破壊的変更に、`ansible-autodoc`（最新版0.5.3を含む）のコードが追従できていないことによるものであった
* `terraform-docs`はTerraform本体のエコシステムと歩調を合わせて更新が続く一方、`ansible-autodoc`は現行の標準的なPython環境と組み合わせて動作せず、両ツールの間には設計思想の違いにとどまらない、保守状況そのものの差があることを実機で確認した

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、パイプラインの実行順序、検証、コード構造の共通化、待ち時間の削減、変化の検知と自動収束という、コードの「動かし方」を中心に改善を重ねてきました。第38回となる今回は、コードそのものの「説明のしかた」を扱いました。`terraform-docs`を用いて`modules/ansible_target_image`から仕様書を自動生成できることを実機で確認した一方、Ansible側で同様の役割を期待した`ansible-autodoc`は、現行の`PyYAML`環境と非互換のため動作しないことが実機で判明しました。

次回は、既存のインフラ運用知識とInfrastructure as Codeのシナジーという、技術検証を離れた考察を扱います。

**[次回：第39回：既存インフラ運用知識とInfrastructure as Code（IaC）のシナジー](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)　｜　[次の記事：【Ansible×Terraform編】第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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
