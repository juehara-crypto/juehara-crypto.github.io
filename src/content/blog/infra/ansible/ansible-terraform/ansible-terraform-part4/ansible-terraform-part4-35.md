---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第35回：共通パーツのモジュール化（Terraformモジュール／Ansibleロール）'
description: 'Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターンを扱う。共通化によってコードの重複が解消される一方で生じる、変更の影響範囲と冪等性の重要性についても整理する。'
pubDate: 2026-09-05
category: 'infra'
tags: ['Ansible', 'Terraform', 'Module', 'Role', 'CI/CD']
seriesId: 'ansible-terraform-part4'
seriesNo: 35
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/'
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
2. [target-node1〜3向け定義の重複という現状](#2-target-node13向け定義の重複という現状)
3. [Terraform Moduleの基本構造](#3-terraform-moduleの基本構造)
4. [Ansible Roleの基本構造](#4-ansible-roleの基本構造)
5. [共通化によるコード量の変化](#5-共通化によるコード量の変化)
6. [共通部分への変更の影響範囲](#6-共通部分への変更の影響範囲)
7. [チーム運用での保守性向上との接続](#7-チーム運用での保守性向上との接続)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

`main.tf`や`site.yml`を見返したとき、似たような定義が複数箇所に散らばっていることに気づいたことはないでしょうか。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** では、TerraformとAnsibleの実行順序をどう設計するか、パイプライン全体をどう検証するかという、実行面の改善を扱ってきました。第35回となる今回は視点を変え、コードそのものの構造をどう整理するかという、保守性の改善を扱います。

問いは、「共通化によってコードの重複は解消されるが、その共通部分に手を入れた際の影響範囲はどう変わるのか」です。

次のセクションでは、この回で解決する課題を具体的に確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. target-node1〜3向け定義の重複という現状

この回で扱う対象を、現状の`main.tf`から確認します。

`main.tf`には、検証用のDockerイメージをビルドする`docker_image`リソースが4つ存在します。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
# 1. SSHD入りの検証用Dockerイメージをビルド
resource "docker_image" "ansible_target" {
  name = "ansible-target:ubuntu22.04"
  build {
    context    = "."
    dockerfile = "Dockerfile"
    build_args = {
      ANSIBLE_USER_PASSWORD = var.ansible_user_password
    }
  }
}
resource "docker_image" "ansible_target_deploy_nopasswd" {
  name = "ansible-target:deploy-nopasswd"
  build {
    context    = "."
    dockerfile = "Dockerfile.deploy_nopasswd"
    build_args = {
      DEPLOY_USER_PASSWORD = var.deploy_user_password
    }
  }
}

resource "docker_image" "ansible_target_deploy_passwd" {
  name = "ansible-target:deploy-passwd"
  build {
    context    = "."
    dockerfile = "Dockerfile.deploy_passwd"
    build_args = {
      DEPLOY_USER_PASSWORD = var.deploy_user_password
    }
  }
}
# 1-b. 第7回：Pythonバージョン不一致検証用のレガシーイメージをビルド
resource "docker_image" "ansible_target_legacy" {
  name = "ansible-target:ubuntu18.04"
  build {
    context    = "."
    dockerfile = "Dockerfile.legacy"
    build_args = {
      ANSIBLE_USER_PASSWORD = var.ansible_user_password
    }
  }
}
```

4つのブロックは、`context`・`build`ブロックの構造が共通しており、異なっているのは`name`・`dockerfile`・`build_args`が参照する変数の3点のみです。

一方、`docker_container.targets`はすでに`for_each`によって1つのリソースブロックにまとめられています。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = docker_image.ansible_target.image_id
  # 以下略
}
```

target-node1〜3向けの個別定義という形での重複は、`docker_container`についてはすでに解消された状態にあります。この回でTerraform側が扱う重複は、複数ノードに対する重複ではなく、`docker_image`という1種類のリソースを、用途違いで複数回、同じ構造のまま書いている重複です。

Ansible側の`site.yml`は、すでに`roles`ディレクトリを呼び出す構成になっています。

* **ファイル名：`site.yml`**

```yaml
---
- name: 接続確認用Playbook
  hosts: target_nodes
  gather_facts: false

  roles:
    - common
```

---

[↑ 目次に戻る](#-目次)

---

## 3. Terraform Moduleの基本構造

重複を解消する仕組みを確認します。

`docker_image`の4ブロックを、`modules/ansible_target_image/`というModuleに切り出します。

* ディレクトリ構成

```
modules/
　└─ ansible_target_image/
　　　├─ main.tf
　　　├─ variables.tf
　　　└─ outputs.tf
```

* **ファイル名：`modules/ansible_target_image/variables.tf`**

```hcl
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

* **ファイル名：`modules/ansible_target_image/main.tf`**

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0.0"
    }
  }
}

resource "docker_image" "this" {
  name = var.image_name
  build {
    context    = "."
    dockerfile = var.dockerfile
    build_args = var.build_args
  }
}
```

* **ファイル名：`modules/ansible_target_image/outputs.tf`**

```hcl
output "image_id" {
  value = docker_image.this.image_id
}
```

呼び出し側のルート`main.tf`は、4つの`docker_image`ブロックを、4つの`module`呼び出しに置き換えます。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
resource "docker_image" "ansible_target" {
  name = "ansible-target:ubuntu22.04"
  build {
    context    = "."
    dockerfile = "Dockerfile"
    build_args = {
      ANSIBLE_USER_PASSWORD = var.ansible_user_password
    }
  }
}
resource "docker_image" "ansible_target_deploy_nopasswd" {
  name = "ansible-target:deploy-nopasswd"
  build {
    context    = "."
    dockerfile = "Dockerfile.deploy_nopasswd"
    build_args = {
      DEPLOY_USER_PASSWORD = var.deploy_user_password
    }
  }
}

resource "docker_image" "ansible_target_deploy_passwd" {
  name = "ansible-target:deploy-passwd"
  build {
    context    = "."
    dockerfile = "Dockerfile.deploy_passwd"
    build_args = {
      DEPLOY_USER_PASSWORD = var.deploy_user_password
    }
  }
}
resource "docker_image" "ansible_target_legacy" {
  name = "ansible-target:ubuntu18.04"
  build {
    context    = "."
    dockerfile = "Dockerfile.legacy"
    build_args = {
      ANSIBLE_USER_PASSWORD = var.ansible_user_password
    }
  }
}
```

**【変更後】**

```hcl
module "image_ansible_target" {
  source     = "./modules/ansible_target_image"
  image_name = "ansible-target:ubuntu22.04"
  dockerfile = "Dockerfile"
  build_args = {
    ANSIBLE_USER_PASSWORD = var.ansible_user_password
  }
}

module "image_deploy_nopasswd" {
  source     = "./modules/ansible_target_image"
  image_name = "ansible-target:deploy-nopasswd"
  dockerfile = "Dockerfile.deploy_nopasswd"
  build_args = {
    DEPLOY_USER_PASSWORD = var.deploy_user_password
  }
}

module "image_deploy_passwd" {
  source     = "./modules/ansible_target_image"
  image_name = "ansible-target:deploy-passwd"
  dockerfile = "Dockerfile.deploy_passwd"
  build_args = {
    DEPLOY_USER_PASSWORD = var.deploy_user_password
  }
}

module "image_legacy" {
  source     = "./modules/ansible_target_image"
  image_name = "ansible-target:ubuntu18.04"
  dockerfile = "Dockerfile.legacy"
  build_args = {
    ANSIBLE_USER_PASSWORD = var.ansible_user_password
  }
}
```

`docker_container.targets`側の参照も、Moduleの出力（`output "image_id"`）を使う形に変更します。

* **ファイル名：`main.tf`（該当箇所）**

**【変更前】**

```hcl
  image    = docker_image.ansible_target.image_id
```

**【変更後】**

```hcl
  image    = module.image_ansible_target.image_id
```

### ■ 検証内容：Module化後のterraform init、plan、apply確認

Module追加に伴い、`terraform init`を再実行します。

**実行コマンド**

```plaintext
terraform init
```

**▼ 実行結果**

```plaintext
Initializing modules...
- image_deploy_nopasswd in modules/ansible_target_image
- image_ansible_target in modules/ansible_target_image
- image_legacy in modules/ansible_target_image
- image_deploy_passwd in modules/ansible_target_image
Initializing provider plugins found in the configuration...
- Reusing previous version of hashicorp/local from the dependency lock file
- Reusing previous version of hashicorp/null from the dependency lock file
- Reusing previous version of hashicorp/tls from the dependency lock file
- Reusing previous version of kreuzwerker/docker from the dependency lock file
- Using previously-installed hashicorp/local v2.9.0
- Using previously-installed hashicorp/null v3.3.0
- Using previously-installed hashicorp/tls v4.3.0
- Using previously-installed kreuzwerker/docker v3.0.2
Initializing the backend...
Initializing provider plugins found in the state...
- Reusing previous version of hashicorp/local
- Reusing previous version of hashicorp/null
- Reusing previous version of hashicorp/tls
- Reusing previous version of kreuzwerker/docker
- Using previously-installed hashicorp/local v2.9.0
- Using previously-installed hashicorp/null v3.3.0
- Using previously-installed hashicorp/tls v4.3.0
- Using previously-installed kreuzwerker/docker v3.0.2
Terraform has made some changes to the provider dependency selections recorded
in the .terraform.lock.hcl file. Review those changes and commit them to your
version control system if they represent changes you intended to make.
Terraform has been successfully initialized!
You may now begin working with Terraform. Try running "terraform plan" to see
any changes that are required for your infrastructure. All Terraform commands
should now work.
If you ever set or change modules or backend configuration for Terraform,
rerun this command to reinitialize your working directory. If you forget, other
commands will detect it and remind you to do so if necessary.
```

続けて`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create
  - destroy
-/+ destroy and then create replacement

（途中省略：docker_container.targets["target-node1"]〜["target-node3"]の作成計画詳細）

  # docker_image.ansible_target will be destroyed
  # (because docker_image.ansible_target is not in configuration)
  - resource "docker_image" "ansible_target" {
      - id          = "sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456ansible-target:ubuntu22.04" -> null
      - image_id    = "sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456" -> null
      - name        = "ansible-target:ubuntu22.04" -> null
      - repo_digest = "ansible-target@sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456" -> null

      - build {
          # At least one attribute in this block is (or was) sensitive,
          # so its contents will not be displayed.
        }
    }

（途中省略：docker_image.ansible_target_deploy_nopasswd、ansible_target_deploy_passwd、ansible_target_legacyのdestroy計画）

  # local_file.ansible_inventory must be replaced
（途中省略：content差分詳細）

  # local_file.group_vars_target_nodes must be replaced
（途中省略：content差分詳細）

  # module.image_ansible_target.docker_image.this will be created
  + resource "docker_image" "this" {
      + id          = (known after apply)
      + image_id    = (known after apply)
      + name        = "ansible-target:ubuntu22.04"
      + repo_digest = (known after apply)

      + build {
          # At least one attribute in this block is (or was) sensitive,
          # so its contents will not be displayed.
        }
    }

（途中省略：module.image_deploy_nopasswd、image_deploy_passwd、image_legacyの作成計画）

Plan: 9 to add, 0 to change, 6 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=098eb605ab8be2e794bd80cb9a745ae80f1de98f]
local_file.group_vars_target_nodes: Destroying... [id=f8f757de49eab333f2dcdec781bcca8fdaedcef4]
local_file.ansible_inventory: Destruction complete after 0s
local_file.group_vars_target_nodes: Destruction complete after 0s
docker_image.ansible_target_legacy: Destroying... [id=sha256:a16c62a2699b6a0020002e924eff95e64e701b5f89b92247875e66365ced49b0ansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_passwd: Destroying... [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-passwd]
docker_image.ansible_target_deploy_nopasswd: Destroying... [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-nopasswd]
module.image_deploy_passwd.docker_image.this: Creating...
docker_image.ansible_target: Destroying... [id=sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456ansible-target:ubuntu22.04]
module.image_legacy.docker_image.this: Creating...
module.image_deploy_nopasswd.docker_image.this: Creating...
module.image_ansible_target.docker_image.this: Creating...
docker_image.ansible_target_deploy_nopasswd: Destruction complete after 3s
docker_image.ansible_target_deploy_passwd: Destruction complete after 6s
docker_image.ansible_target_legacy: Destruction complete after 8s
docker_image.ansible_target: Destruction complete after 8s
module.image_ansible_target.docker_image.this: Still creating... [00m10s elapsed]
module.image_deploy_nopasswd.docker_image.this: Still creating... [00m10s elapsed]
module.image_deploy_passwd.docker_image.this: Still creating... [00m10s elapsed]
module.image_legacy.docker_image.this: Still creating... [00m10s elapsed]
module.image_ansible_target.docker_image.this: Still creating... [00m20s elapsed]
module.image_legacy.docker_image.this: Still creating... [00m20s elapsed]
module.image_deploy_nopasswd.docker_image.this: Still creating... [00m20s elapsed]
module.image_deploy_passwd.docker_image.this: Still creating... [00m20s elapsed]
module.image_ansible_target.docker_image.this: Still creating... [00m30s elapsed]
module.image_deploy_passwd.docker_image.this: Still creating... [00m30s elapsed]
module.image_legacy.docker_image.this: Still creating... [00m30s elapsed]
module.image_deploy_nopasswd.docker_image.this: Still creating... [00m30s elapsed]
module.image_ansible_target.docker_image.this: Creation complete after 31s [id=sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456ansible-target:ubuntu22.04]
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node2"]: Creating...
module.image_deploy_nopasswd.docker_image.this: Creation complete after 32s [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-nopasswd]
module.image_legacy.docker_image.this: Creation complete after 32s [id=sha256:a16c62a2699b6a0020002e924eff95e64e701b5f89b92247875e66365ced49b0ansible-target:ubuntu18.04]
module.image_deploy_passwd.docker_image.this: Creation complete after 32s [id=sha256:82e7f3fe0d4812ff81d66c343eb1c9256083f74beaa95a6ea0cbbd4cf248649dansible-target:deploy-passwd]
docker_container.targets["target-node2"]: Creation complete after 3s [id=19ae402d9ebf9ecc791e87b805eafc19d6f951064894305ee3a83baa8d73e43a]
docker_container.targets["target-node3"]: Creation complete after 4s [id=ccd21507ab2a872dfb804421642a82d17e690ac0e9169d0d737ed42f948f22d8]
docker_container.targets["target-node1"]: Creation complete after 4s [id=62e3548f06a260c96491b117d08bae679b12e9364e958fc60f7b218aab16b349]
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=098eb605ab8be2e794bd80cb9a745ae80f1de98f]
local_file.group_vars_target_nodes: Creation complete after 0s [id=f8f757de49eab333f2dcdec781bcca8fdaedcef4]

Apply complete! Resources: 9 added, 0 changed, 6 destroyed.

Outputs:

target_nodes = {
  "target-node1" = {
    "host" = "172.18.0.2"
    "port" = 22
  }
  "target-node2" = {
    "host" = "172.20.0.3"
    "port" = 22
  }
  "target-node3" = {
    "host" = "172.20.0.4"
    "port" = 22
  }
}
target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.4"
}
```

### ■ 結果

`Plan: 9 to add, 0 to change, 6 to destroy`となり、既存の4つの`docker_image`が破棄され、Module経由で4つの`docker_image`（`module.image_ansible_target.docker_image.this`等）が新規作成される計画が示されました。あわせて`docker_container.targets`（target-node1〜3）3つ、`local_file.ansible_inventory`、`local_file.group_vars_target_nodes`も再作成の対象となりました。

`Apply complete! Resources: 9 added, 0 changed, 6 destroyed`となり、Module化後の`docker_image`が正常にビルドされ、target-node1〜3のコンテナも新しいイメージ参照で再作成されました。`docker_container.targets`が参照するイメージのアドレスは、`docker_image.ansible_target.image_id`から`module.image_ansible_target.image_id`に変わりましたが、コンテナとしての機能（SSHD入りのイメージから起動する）自体は変わっていません。

呼び出し側の`main.tf`には、`node_name`にあたる差分（`image_name`・`dockerfile`・`build_args`）のみが残り、`docker_image`リソースの定義本体はModule側に1箇所だけ存在する構造になりました。

---

[↑ 目次に戻る](#-目次)

---

## 4. Ansible Roleの基本構造

Ansible側の重複解消の仕組みを、実機での変更を通じて確認します。

現状の`common`ロールは`tasks`ディレクトリのみを使っており、`defaults`・`handlers`・`templates`は使われていません。ここでは、タスク名を`defaults`に切り出し、呼び出し側から上書き可能な構造に変更します。

* **ファイル名：`roles/common/tasks/main.yml`**

**【変更前】**

```yaml
---
- name: 疎通確認（common role・更新後）
  ansible.builtin.ping:
```

**【変更後】**

```yaml
---
- name: "{{ common_ping_task_name }}"
  ansible.builtin.ping:
```

* **ファイル名：`roles/common/defaults/main.yml`（新規作成）**

```yaml
---
common_ping_task_name: "疎通確認（common role）"
```

`defaults`ディレクトリに置いた変数は、Role内で最も優先度の低いデフォルト値として扱われ、呼び出し側（`site.yml`や`group_vars`）で同名の変数を定義すれば上書きできます。

### ■ 検証内容：defaults切り替え後におけるAnsible単体実行の確認

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************
TASK [common : 疎通確認（common role）] *****************************************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

タスク名が`TASK [common : 疎通確認（common role）]`として表示され、`defaults/main.yml`で定義した`common_ping_task_name`の値がそのまま反映されていることが確認できました。target-node1〜3のすべてで`ok=1、changed=0、unreachable=0、failed=0`となり、セクション3でModule化した新しいコンテナに対しても、Ansibleの疎通確認が正常に機能しています。

`common`ロールは、これまで`tasks`単体で完結していた構造から、`tasks`と`defaults`が連携する構造に変わりました。ロール内にハードコードされていた値が`defaults`側に切り出されたことで、呼び出し側から値を上書きできる余地が生まれています。

---

[↑ 目次に戻る](#-目次)

---

## 5. 共通化によるコード量の変化

共通化前後のコード行数を、実際のファイルから比較します。

**Terraform側**

|項目|共通化前|共通化後|
|---|---|---|
|ルート`main.tf`該当箇所|`docker_image`4ブロック：43行（23〜65行目、コメント含む）|`module`呼び出し4ブロック：37行（23〜59行目、コメント含む）|
|Module本体（新規）|なし|`main.tf`17行＋`variables.tf`11行＋`outputs.tf`3行＝31行|
|合計|43行|68行|

ルート`main.tf`側の記述だけを見ると43行から37行に減っていますが、Module本体として31行が新たに追加されているため、プロジェクト全体のコード行数としては43行から68行に増えています。

**Ansible側**

|項目|共通化前|共通化後|
|---|---|---|
|`roles/common/tasks/main.yml`|3行|3行|
|`roles/common/defaults/main.yml`（新規）|なし|2行|
|合計|3行|5行|

Ansible側も同様に、`defaults`を切り出したことでファイル数・行数はわずかに増えています。

**行数比較から見えること**

いずれのケースも、共通化によって総行数が減ったわけではありません。増えた行数の内訳は、Module・Roleという「箱」を成立させるための構造的なコード（`variable`宣言、`output`定義）です。行数の増減そのものよりも、共有すべき定義が1箇所（Module本体）に集約され、呼び出し側にはノードごとの差分（`image_name`・`dockerfile`・`build_args`）だけが残った、という構造の変化が本質的な効果です。

---

[↑ 目次に戻る](#-目次)

---

## 6. 共通部分への変更の影響範囲

Roleの共通部分に変更を加えた場合、その影響がtarget-node1〜3すべてに及ぶことを実機で確認します。

`roles/common/defaults/main.yml`の値を1箇所変更します。

* **ファイル名：`roles/common/defaults/main.yml`**

**【変更前】**

```yaml
---
common_ping_task_name: "疎通確認（common role）"
```

**【変更後】**

```yaml
---
common_ping_task_name: "疎通確認（common role・第35回更新）"
```

### ■ 検証内容：defaults変更後における全ノードへの反映確認

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************
TASK [common : 疎通確認（common role・第35回更新）] *****************************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`defaults/main.yml`の1行を書き換えただけで、target-node1〜3すべてのタスク名が`疎通確認（common role・第35回更新）`に一括して変わりました。target-node1〜3それぞれに対して個別の修正を加える必要はなく、`common`ロールを呼び出しているすべてのノードに、共通部分の変更が自動的に反映されています。

この一括反映は、共通化前であれば得られなかった性質です。仮に`common_ping_task_name`のような値ではなく、実際に何らかの処理を行うタスクが`common`ロール側に含まれていた場合、そのタスクに冪等性の問題（複数回実行すると結果が変わる、失敗する等）があれば、その影響もtarget-node1〜3すべてに同時に及びます。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)** で扱った冪等性の重要性は、共通化によってノード間で連動する範囲が広がった分、共通化前よりも高くなります。

TerraformのModule側についても、同様の構造が成り立ちます。セクション3で確認した通り、4つの`docker_image`はすべて`modules/ansible_target_image/`という1つのModuleを参照しています。このModule本体（`main.tf`）に変更を加えれば、その影響は`image_ansible_target`・`image_deploy_nopasswd`・`image_deploy_passwd`・`image_legacy`という4つの呼び出し元すべてに及びます。

---

[↑ 目次に戻る](#-目次)

---

## 7. チーム運用での保守性向上との接続

この回の締めくくりとして、運用面の意味を整理します。

複数人でコードを触る運用を想定した場合、共通化前後で状況が変わります。

共通化前は、target-node1〜3向けの定義がそれぞれ独立していたため、ある担当者が加えた変更は、その担当者が触ったノードにしか及びませんでした。一方で、ある担当者が1つのノード向けにだけ修正を加え、他のノードへの反映を忘れるということも起こり得ました。修正が漏れているかどうかは、複数の定義を見比べない限り把握できません。

共通化後は、`modules/ansible_target_image/`や`roles/common/`という1箇所を直せば、それを参照しているすべてのノードに変更が及びます。セクション6で確認した通り、`defaults/main.yml`の1行の変更が、target-node1〜3すべてに一括で反映されました。「どこを直せば全体に反映されるか」は、Module・Role単位で明確になります。

その一方で、この一括反映という性質は、複数人での運用において新しい課題を生みます。誰かが`common`ロールや`ansible_target_image`Moduleに変更を加えた場合、その影響は、変更を加えた本人が意図していないノードにも及びます。共通化前であれば、影響範囲は「自分が触ったノードだけ」でしたが、共通化後は「そのModule・Roleを参照しているすべてのノード」に広がります。誰が、どのタイミングで、共通部分に変更を加えてよいか、変更前にどう確認し合うかという運用ルールが必要になります。

この回では、この運用ルールの具体的な設計（レビュー体制やアクセス権限の管理等）までは扱いません。共通化が、コードの重複解消という効果と同時に、変更の影響範囲をチーム全体に広げるという性質を持つ、という課題の所在を示すにとどめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* target-node1〜3向けのDockerイメージ定義（`docker_image`4ブロック）は、`context`・`build`の構造が共通しているにもかかわらず、用途違いで4回同じ形を書いており、修正箇所が分散していた
* TerraformのModuleは、`variables.tf`・`outputs.tf`を介して入出力を定義し、`source`で呼び出すことでコードを再利用できる仕組みであることを実機で確認した
* Module化前後でルート`main.tf`側の行数は減少したが、Module本体のコードが新たに加わるため、プロジェクト全体のコード行数としては増加した。行数の増減よりも、共有すべき定義が1箇所に集約されることが本質的な効果である
* AnsibleのRoleは`tasks`・`defaults`等のディレクトリで構成され、`defaults`に値を切り出すことで、呼び出し側から上書き可能な構造になることを実機で確認した
* `defaults`側の1箇所の変更が、target-node1〜3すべてに一括で反映されることを実機で確認した。この一括反映は、共通化されたModule・Roleが冪等でない場合、影響がすべての呼び出し元に及ぶことも意味する
* 共通化は、チーム運用において「どこを直せば全体に反映されるか」を明確にする一方、「誰が共通部分を変更してよいか」という新しい運用ルールの必要性を生む

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、Terraformの責務を状態の出力に限定する疎結合設計への移行を、**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** では、GitHub Actionsを用いたCI環境の構築を、**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)** では、`triggers`によるAnsible実行の抑制を、**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** では、Testinfraによるパイプライン全体の状態検証を、それぞれ扱いました。第35回となる今回は、視点を変え、コードそのものの構造をどう整理するかという保守性の改善を扱いました。target-node1〜3向けのDockerイメージ定義をTerraform Moduleに、`common`ロールのタスク名をAnsibleの`defaults`に切り出し、共通化によってコードの重複が解消される一方、共通部分への変更がすべての呼び出し元に一括で影響する構造を実機検証を交えて確認しました。

次回は、Terraformのプラグインキャッシュとaptパッケージキャッシュにより、検証サイクルの待ち時間を短縮する手法を扱います。

**[次回：第36回：プラグインおよびパッケージのキャッシュによる開発効率の向上](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)　｜　[次の記事：【Ansible×Terraform編】第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**

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
