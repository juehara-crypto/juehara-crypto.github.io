---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第30回：デバッグフラグの組み合わせによるログ解析の高度化'
description: 'Terraformの`TF_LOG`とAnsibleの`-vvvv`という、それぞれ独立した詳細度制御の仕組みを整理する。両者を組み合わせることで、第21回から第29回まで扱ってきた個別の問題の原因特定を、体系的な手順として横断的に扱えることを示す。'
pubDate: 2026-09-05
category: 'infra'
tags: ['Ansible', 'Terraform', 'TF_LOG', '-vvvv', 'デバッグ']
seriesId: 'ansible-terraform-part3'
seriesNo: 30
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/'
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
2. [Terraformの`TF_LOG`環境変数](#2-terraformのtf_log環境変数)
3. [Ansibleの`-vvvv`コマンドオプション](#3-ansibleの-vvvvコマンドオプション)
4. [情報量とノイズのトレードオフ](#4-情報量とノイズのトレードオフ)
5. [grepによるログの絞り込み](#5-grepによるログの絞り込み)
6. [過去の回への当てはめ](#6-過去の回への当てはめ)
7. [ログの相関確認](#7-ログの相関確認)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「エラーが起きたら、とりあえず再現してログを見ればいい」と考えたことはないでしょうか。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** では、`local-exec`経由で実行したAnsibleのエラーが、Terraformの実行ログの中でどう変質するかを整理し、ログの読み解き方という土台を扱いました。**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** から **[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** にかけては、ネットワーク、並列実行、認証、依存関係等、個別の事象を扱ってきました。**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** は第3部の最終回として、これらの回で個別に登場した原因特定の場面を振り返りながら、Terraformの`TF_LOG`環境変数とAnsibleの`-vvvv`コマンドオプションという詳細度制御の仕組み自体を体系的に整理します。

「エラーが起きたら再現してログを見ればいい」という理解だけでは、この回において不十分です。デフォルトの出力レベルでは、Terraform側もAnsible側も、成功したか失敗したかという大まかな要約程度の情報しか出力しません。Terraformの`TF_LOG`環境変数はTerraform内部のプロバイダー呼び出し、HTTP通信、状態操作の詳細を、Ansibleの`-vvvv`コマンドオプションはAnsibleのモジュール呼び出し、変数展開、接続処理の詳細を、それぞれ段階的に出力させる仕組みを持ちます。

この回で扱う問いは、「どのレベルのフラグを、どの場面で、どう組み合わせれば、必要な情報だけを得られるのか」です。

次のセクションでは、まずTerraformの`TF_LOG`環境変数が持つレベル構造を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraformの`TF_LOG`環境変数

Terraform側の詳細度制御を整理します。

Terraformには`TF_LOG`という環境変数が用意されており、`TRACE`、`DEBUG`、`INFO`、`WARN`、`ERROR`という段階でログの詳細度を制御できます。`TF_LOG_PATH`と組み合わせることで、このログを標準出力とは別のファイルに分離して取得できます。この仕組みは、**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で扱った`ANSIBLE_LOG_PATH`と対になるものです。

まずは`DEBUG`レベルで、実際にどこまでの情報が出力されるかを確認します。

### ■ 検証内容：`TF_LOG=DEBUG`で出力される範囲の確認

`docker_container.targets["target-node1"]`を対象に`-replace`で強制再生成し、`TF_LOG=DEBUG`の出力内容を`TF_LOG_PATH`でファイルに分離取得します。

**実行コマンド**

```plaintext
TF_LOG=DEBUG TF_LOG_PATH=~/iac/docker-lab/logs/terraform_debug2.log terraform apply -replace="docker_container.targets[\"target-node1\"]"
```

**▼ 実行結果**

```plaintext
（途中省略：Planの属性差分表示）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
local_file.group_vars_target_nodes: Destroying... [id=4cc3688710c2cdd461df58007e589aeca224b12f]
local_file.ansible_inventory: Destruction complete after 0s
local_file.group_vars_target_nodes: Destruction complete after 0s
docker_container.targets["target-node1"]: Destroying... [id=6c2ebf47421c09221e651cfcc0e2674ca6b324fb634d3a4a5771cf0414a69054]
docker_container.targets["target-node1"]: Destruction complete after 1s
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 1s [id=01169c11aef92215adec3b9df5bad62608f72131f022eb44db28fca209bdef0e]
local_file.group_vars_target_nodes: Creating...
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creation complete after 0s [id=4cc3688710c2cdd461df58007e589aeca224b12f]
local_file.ansible_inventory: Creation complete after 0s [id=3ded465751ae7883faf871c4895d1c5d735723c3]

Apply complete! Resources: 3 added, 0 changed, 3 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

続けて、分離取得した`terraform_debug2.log`から、Dockerに関連する記述を確認します。

**実行コマンド**

```plaintext
grep -n "docker\|http\." ~/iac/docker-lab/logs/terraform_debug2.log | head -50
```

**▼ 実行結果**

```plaintext
7:2026-08-28T00:53:34.530Z [INFO]  CLI args: []string{"terraform", "apply", "-replace=docker_container.targets[\"target-node1\"]"}
16:2026-08-28T00:53:34.542Z [INFO]  CLI command args: []string{"apply", "-replace=docker_container.targets[\"target-node1\"]"}
61:2026-08-28T00:53:35.343Z [DEBUG] provider: starting plugin: path=.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64/terraform-provider-docker_v3.0.2 args=[".terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64/terraform-provider-docker_v3.0.2"]
62:2026-08-28T00:53:35.344Z [DEBUG] provider: plugin started: path=.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64/terraform-provider-docker_v3.0.2 pid=2110
63:2026-08-28T00:53:35.344Z [DEBUG] provider: waiting for RPC address: plugin=.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64/terraform-provider-docker_v3.0.2
64:2026-08-28T00:53:35.361Z [INFO]  provider.terraform-provider-docker_v3.0.2: configuring server automatic mTLS: timestamp=2026-08-28T00:53:35.360Z
65:2026-08-28T00:53:35.378Z [DEBUG] provider.terraform-provider-docker_v3.0.2: plugin address: address=/tmp/plugin3075760702 network=unix timestamp=2026-08-28T00:53:35.378Z
68:2026-08-28T00:53:35.417Z [INFO]  provider: plugin process exited: plugin=.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64/terraform-provider-docker_v3.0.2 id=2110
76:2026-08-28T00:53:35.418Z [DEBUG] ProviderTransformer: "docker_image.ansible_target" (*terraform.NodeValidatableResource) needs provider["registry.terraform.io/kreuzwerker/docker"]
（途中省略：以降、ProviderTransformer、ReferenceTransformerによるリソース依存関係のグラフ構築ログが続く）
```

### ■ 結果

`grep`の結果から分かる通り、`TF_LOG=DEBUG`で記録されているのは、プロバイダープラグインの起動、終了（`provider: starting plugin`、`provider: plugin process exited`）と、Terraformコア内部でのリソース依存関係のグラフ構築処理（`ProviderTransformer`、`ReferenceTransformer`）です。`http.`という文字列は1件もヒットせず、コンテナの作成にあたってDocker daemonへ実際にどのような操作が行われたかという情報は、`DEBUG`レベルには一切含まれていません。

`DEBUG`レベルは、Terraformコア本体が「何をしようとしているか」を追うためのログであり、プロバイダーが対象システム（今回はDocker daemon）に対して実際に何を行ったかを追うためのログではないことが、この結果から分かります。

次に、`TRACE`レベルまで上げた場合にどう変わるかを確認します。

### ■ 検証内容：`TF_LOG=TRACE`で表面化する情報の確認

同様の手順で、`docker_container.targets["target-node2"]`を対象に`-replace`で強制再生成し、今度は`TF_LOG=TRACE`で出力を取得します。

**実行コマンド**

```plaintext
TF_LOG=TRACE TF_LOG_PATH=~/iac/docker-lab/logs/terraform_trace.log terraform apply -replace="docker_container.targets[\"target-node2\"]"
```

**▼ 実行結果**

```plaintext
（途中省略：Planの属性差分表示）

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
local_file.group_vars_target_nodes: Destroying... [id=4cc3688710c2cdd461df58007e589aeca224b12f]
local_file.group_vars_target_nodes: Destruction complete after 0s
local_file.ansible_inventory: Destruction complete after 0s
docker_container.targets["target-node2"]: Destroying... [id=f8231edf92f14e603710904f2fbfab1b0eb685ea632c233601a4e3cab45b6ce9]
docker_container.targets["target-node2"]: Destruction complete after 1s
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node2"]: Creation complete after 3s [id=a2fa3bd6726d718f27b55300e949e09b9dd60b35d78f039d70bd5f66b6d1739f]
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creating...
local_file.group_vars_target_nodes: Creation complete after 0s [id=4cc3688710c2cdd461df58007e589aeca224b12f]
local_file.ansible_inventory: Creation complete after 0s [id=3ded465751ae7883faf871c4895d1c5d735723c3]

Apply complete! Resources: 3 added, 0 changed, 3 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

続けて、分離取得した`terraform_trace.log`のうち、`docker_container.targets["target-node2"]`の実際の作成処理にあたる区間を確認します。

**実行コマンド**

```plaintext
sed -n '7106,7250p' ~/iac/docker-lab/logs/terraform_trace.log
```

**▼ 実行結果**

```plaintext
2026-08-28T00:57:57.211Z [DEBUG] docker_container.targets["target-node2"]: applying the planned Create change
2026-08-28T00:57:57.212Z [TRACE] GRPCProvider: ApplyResourceChange
2026-08-28T00:57:57.212Z [TRACE] GRPCProvider: GetProviderSchema
2026-08-28T00:57:57.224Z [TRACE] provider.terraform-provider-docker_v3.0.2: Received request: tf_proto_version=5.3 tf_provider_addr=provider @caller=github.com/hashicorp/terraform-plugin-go@v0.14.3/tfprotov5/tf5server/server.go:805 tf_req_id=138f5a21-054b-9226-1d62-b86ca47d3829 tf_resource_type=docker_container tf_rpc=ApplyResourceChange @module=sdk.proto timestamp=2026-08-28T00:57:57.218Z
2026-08-28T00:57:57.224Z [TRACE] provider.terraform-provider-docker_v3.0.2: Sending request downstream: @module=sdk.proto tf_req_id=138f5a21-054b-9226-1d62-b86ca47d3829 tf_resource_type=docker_container tf_proto_version=5.3 tf_provider_addr=provider tf_rpc=ApplyResourceChange @caller=github.com/hashicorp/terraform-plugin-go@v0.14.3/tfprotov5/internal/tf5serverlogging/downstream_request.go:17 timestamp=2026-08-28T00:57:57.218Z
2026-08-28T00:57:57.224Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:57 [DEBUG] suppress diff ports: old and new don't have the same length: timestamp=2026-08-28T00:57:57.221Z
（途中省略：同様のsuppress diff、setting computedのログが複数続く）
2026-08-28T00:57:57.225Z [TRACE] provider.terraform-provider-docker_v3.0.2: Calling downstream: @caller=github.com/hashicorp/terraform-plugin-sdk/v2@v2.25.0/helper/schema/resource.go:836 @module=sdk.helper_schema tf_req_id=138f5a21-054b-9226-1d62-b86ca47d3829 tf_resource_type=docker_container tf_provider_addr=provider tf_rpc=ApplyResourceChange timestamp=2026-08-28T00:57:57.223Z
2026-08-28T00:57:57.848Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:57 [DEBUG] Docker image inspect from readFunc: {
        "Id": "sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30",
        "RepoTags": [
                "ansible-target:ubuntu22.04"
        ],
（途中省略：イメージのメタデータ詳細）
        "Metadata": {
                "LastTagTime": "2026-08-14T00:34:17.576743243Z"
        }
}: timestamp=2026-08-28T00:57:57.847Z
2026-08-28T00:57:57.851Z  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:57 [DEBUG] found local image via imageName: sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30: timestamp=2026-08-28T00:57:57.849Z
2026-08-28T00:57:58.297Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:58 [INFO] retContainer container.ContainerCreateCreatedBody{ID:"a2fa3bd6726d718f27b55300e949e09b9dd60b35d78f039d70bd5f66b6d1739f", Warnings:[]string{}}: timestamp=2026-08-28T00:57:58.295Z
2026-08-28T00:57:59.608Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:59 [INFO] Waiting for container: 'a2fa3bd6726d718f27b55300e949e09b9dd60b35d78f039d70bd5f66b6d1739f' to run: max '15 seconds': timestamp=2026-08-28T00:57:59.607Z
2026-08-28T00:57:59.625Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:59 [DEBUG] Waiting for state to become: [running]: timestamp=2026-08-28T00:57:59.625Z
2026-08-28T00:57:59.734Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:59 [DEBUG] Docker container inspect: {
        "Id": "a2fa3bd6726d718f27b55300e949e09b9dd60b35d78f039d70bd5f66b6d1739f",
        "Created": "2026-08-28T00:57:57.901113796Z",
        "Path": "/usr/sbin/sshd",
        "Args": [
                "-D"
        ],
        "State": {
                "Status": "running",
                "Running": true,
                "Paused": false,
                "Restarting": false,
                "OOMKilled": false,
                "Dead": false,
                "Pid": 2568,
                "ExitCode": 0,
                "Error": "",
                "StartedAt": "2026-08-28T00:57:58.578210834Z",
                "FinishedAt": "0001-01-01T00:00:00Z"
        },
        "Image": "sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30",
        "Name": "/target-node2",
        "HostConfig": {
                "NetworkMode": "bridge",
                "PortBindings": {
                        "22/tcp": [
                                {
                                        "HostIp": "0.0.0.0",
                                        "HostPort": "2222"
                                }
                        ]
                },
                "RestartPolicy": {
                        "Name": "no",
                        "MaximumRetryCount": 0
                },
（途中省略：以降、HostConfigの詳細が続く）
```

### ■ 結果

`TF_LOG=TRACE`まで上げると、`GRPCProvider: ApplyResourceChange`というTerraformコアからプロバイダーへのRPC呼び出しに続けて、プロバイダー自身が内部で保持しているログ（`provider.terraform-provider-docker_v3.0.2:`という接頭辞の中に、さらに`[DEBUG]`、`[INFO]`というプロバイダー独自のログレベル表記が埋め込まれている）が表面化しました。

この中には、対象イメージのinspect結果（`Docker image inspect from readFunc`）、コンテナ作成結果（`retContainer container.ContainerCreateCreatedBody{ID:...}`）、作成後のコンテナinspect結果（`Docker container inspect`）が、いずれもJSON形式でそのまま記録されています。これらは、`kreuzwerker/docker`プロバイダーがDocker daemonとのやり取りの中で取得した情報そのものであり、`DEBUG`レベルでは一切見えなかった情報です。

つまり、`TF_LOG`のレベルを`DEBUG`から`TRACE`に上げることで見えるようになるのは、単に「同じ種類の情報が増える」ということではありません。`DEBUG`はTerraformコア本体の内部処理（グラフ構築、プラグインプロセスの起動終了）を追うためのログであるのに対し、`TRACE`まで上げて初めて、プロバイダーが対象システムに対して実際に何を行ったかという、`kreuzwerker/docker`プロバイダー自身のログが表面化するという、階層の異なる情報が追加されます。

分離取得したログファイルの行数を比較すると、この情報量の差は明確です。

**実行コマンド**

```plaintext
wc -l ~/iac/docker-lab/logs/terraform_debug2.log ~/iac/docker-lab/logs/terraform_trace.log
```

**▼ 実行結果**

```plaintext
   3061 /home/control/iac/docker-lab/logs/terraform_debug2.log
   8031 /home/control/iac/docker-lab/logs/terraform_trace.log
  11092 total
```

同じ1リソースの再作成という同一の操作に対し、`DEBUG`が3061行であるのに対し`TRACE`は8031行と、2倍以上の差があります。この情報量の増加が実務上どう扱いにくくなるかは、後のセクションで改めて整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. Ansibleの`-vvvv`コマンドオプション

Ansible側の詳細度制御を整理します。

`ansible-playbook`には`-v`から`-vvvv`まで、`v`の数で指定する4段階の詳細度オプションがあります。まずは1段階ずつ実行し、それぞれのレベルで何が新たに出力されるかを確認します。

対象は **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で使用した`test_nested_normal.yml`（正常系）です。

### ■ 検証内容：`-v`での実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml -v
```

**▼ 実行結果**

```plaintext
Using /home/control/iac/docker-lab/ansible.cfg as config file
PLAY [local-execログ構造デモ（正常系）] ****************************************

TASK [検証用ディレクトリを作成する] ********************************************
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
changed: [target-node1] => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"}, "changed": true, "gid": 0, "group": "root", "mode": "0755", "owner": "root", "path": "/etc/myapp_demo", "size": 4096, "state": "directory", "uid": 0}

TASK [検証用設定ファイルを配置する] ********************************************
changed: [target-node1] => {"changed": true, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "dest": "/etc/myapp_demo/demo.conf", "gid": 0, "group": "root", "md5sum": "8df77851c1639a04327ad704eeb24e24", "mode": "0644", "owner": "root", "size": 23, "src": "/home/ansible/.ansible/tmp/ansible-tmp-1787879872.2983797-2711-76323437498564/.source.conf", "state": "file", "uid": 0}

PLAY RECAP **********************************************************************
target-node1               : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`-v`では、デフォルト出力（`changed:`、`ok:`のみ）に加え、各タスクの結果がJSON形式で表示されます。今回の例では、ディレクトリのパーミッションや所有者、ファイルのチェックサムといった変更結果が確認できます。

### ■ 検証内容：`-vv`での実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml -vv
```

**▼ 実行結果**

```plaintext
ansible-playbook [core 2.17.14]
  config file = /home/control/iac/docker-lab/ansible.cfg
  configured module search path = ['/home/control/.ansible/plugins/modules', '/usr/share/ansible/plugins/modules']
  ansible python module location = /home/control/ansible-env/lib/python3.10/site-packages/ansible
  ansible collection location = /home/control/.ansible/collections:/usr/share/ansible/collections
  executable location = /home/control/ansible-env/bin/ansible-playbook
  python version = 3.10.12 (main, Jun 22 2026, 18:55:27) [GCC 11.4.0] (/home/control/ansible-env/bin/python3)
  jinja version = 3.1.6
  libyaml = True
Using /home/control/iac/docker-lab/ansible.cfg as config file
Skipping callback 'default', as we already have a stdout callback.
Skipping callback 'minimal', as we already have a stdout callback.
Skipping callback 'oneline', as we already have a stdout callback.
PLAYBOOK: test_nested_normal.yml ************************************************************************************************************************************************************
1 plays in ../ansible/playbooks/test_nested_normal.yml
PLAY [local-execログ構造デモ（正常系）] *****************************************************************************************************************************************************

TASK [検証用ディレクトリを作成する] *********************************************************************************************************************************************************
task path: /home/control/iac/ansible/playbooks/test_nested_normal.yml:7
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1] => {"ansible_facts": {"discovered_interpreter_python": "/usr/bin/python3.10"}, "changed": false, "gid": 0, "group": "root", "mode": "0755", "owner": "root", "path": "/etc/myapp_demo", "size": 4096, "state": "directory", "uid": 0}

TASK [検証用設定ファイルを配置する] *********************************************************************************************************************************************************
task path: /home/control/iac/ansible/playbooks/test_nested_normal.yml:12
ok: [target-node1] => {"changed": false, "checksum": "e184461f4646921eabc5a2a0a90a001760003484", "dest": "/etc/myapp_demo/demo.conf", "gid": 0, "group": "root", "mode": "0644", "owner": "root", "path": "/etc/myapp_demo/demo.conf", "size": 23, "state": "file", "uid": 0}

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`-vv`では、`-v`との差分として2点が新たに加わります。冒頭にAnsible自体の設定情報（config file、モジュール検索パス、Python環境、Jinja2バージョン等）が表示される点、そして各タスクの実行直前に`task path: /home/control/iac/ansible/playbooks/test_nested_normal.yml:7`という形で、実行中のタスクがPlaybookファイルの何行目に対応するかが表示される点です。なお、今回は2回目の実行にあたるため、両タスクとも`changed: false`（`ok:`）となっており、Ansibleの冪等性により前回適用済みの状態が維持されていることが確認できます。

### ■ 検証内容：`-vvv`での実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml -vvv
```

**▼ 実行結果**

```plaintext
ansible-playbook [core 2.17.14]
  config file = /home/control/iac/docker-lab/ansible.cfg
（途中省略：バージョン情報ブロック）
Using /home/control/iac/docker-lab/ansible.cfg as config file
host_list declined parsing /home/control/iac/docker-lab/inventory.ini as it did not pass its verify_file() method
auto declined parsing /home/control/iac/docker-lab/inventory.ini as it did not pass its verify_file() method
yaml declined parsing /home/control/iac/docker-lab/inventory.ini as it did not pass its verify_file() method
Parsed /home/control/iac/docker-lab/inventory.ini inventory source with ini plugin
（途中省略：callback読み込みのスキップ表示）

PLAYBOOK: test_nested_normal.yml ************************************************************************************************************************************************************
1 plays in ../ansible/playbooks/test_nested_normal.yml

PLAY [local-execログ構造デモ（正常系）] *****************************************************************************************************************************************************

TASK [検証用ディレクトリを作成する] *********************************************************************************************************************************************************
task path: /home/control/iac/ansible/playbooks/test_nested_normal.yml:7
<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
<172.18.0.2> SSH: EXEC ssh -vvv -C -o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=no -o 'IdentityFile="/home/control/.ssh/id_ed25519"' -o KbdInteractiveAuthentication=no -o PreferredAuthentications=gssapi-with-mic,gssapi-keyex,hostbased,publickey -o PasswordAuthentication=no -o 'User="ansible"' -o ConnectTimeout=10 -o 'ControlPath="/home/control/.ansible/cp/5aa7fea824"' 172.18.0.2 '/bin/sh -c '"'"'echo ~ansible && sleep 0'"'"''
<172.18.0.2> (0, b'/home/ansible\n', b'OpenSSH_8.9p1 Ubuntu-3ubuntu0.16, OpenSSL 3.0.2 15 Mar 2026\r\ndebug1: Reading configuration data /home/control/.ssh/config\r\n（途中省略：SSHのキー交換、認証方式ネゴシエーションのdebug出力）\r\ndebug2: set_control_persist_exit_time: schedule exit in 60 seconds\r\n')
（途中省略：Python interpreter discoveryの過程）
<target-node1> Python interpreter discovery fallback (unsupported Linux distribution: ubuntu)
Using module file /home/control/ansible-env/lib/python3.10/site-packages/ansible/modules/file.py
<172.18.0.2> PUT /home/control/.ansible/tmp/ansible-local-28575juyzqt0/tmpp8gc7lrv TO /home/ansible/.ansible/tmp/ansible-tmp-1787880021.1727023-2861-128104186493647/AnsiballZ_file.py
<172.18.0.2> SSH: EXEC sftp -b - -vvv -C -o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=no -o 'IdentityFile="/home/control/.ssh/id_ed25519"' -o KbdInteractiveAuthentication=no -o PreferredAuthentications=gssapi-with-mic,gssapi-keyex,hostbased,publickey -o PasswordAuthentication=no -o 'User="ansible"' -o ConnectTimeout=10 -o 'ControlPath="/home/control/.ansible/cp/5aa7fea824"' '[172.18.0.2]'
（途中省略：SFTPプロトコルレベルのファイル転送過程）
<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
<172.18.0.2> SSH: EXEC ssh -vvv -C -o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=no -o 'IdentityFile="/home/control/.ssh/id_ed25519"' -o KbdInteractiveAuthentication=no -o PreferredAuthentications=gssapi-with-mic,gssapi-keyex,hostbased,publickey -o PasswordAuthentication=no -o 'User="ansible"' -o ConnectTimeout=10 -o 'ControlPath="/home/control/.ansible/cp/5aa7fea824"' -tt 172.18.0.2 '/bin/sh -c '"'"'sudo -H -S -n  -u root /bin/sh -c '"'"'"'"'"'"'"'"'echo BECOME-SUCCESS-qifozymdkudijlvznrzfcazplmhtjanm ; /usr/bin/python3.10 /home/ansible/.ansible/tmp/ansible-tmp-1787880021.1727023-2861-128104186493647/AnsiballZ_file.py'"'"'"'"'"'"'"'"' && sleep 0'"'"''
Escalation succeeded
<172.18.0.2> (0, b'\r\n{"path": "/etc/myapp_demo", "changed": false, "diff": {"before": {"path": "/etc/myapp_demo"}, "after": {"path": "/etc/myapp_demo"}}, "uid": 0, "gid": 0, "owner": "root", "group": "root", "mode": "0755", "state": "directory", "size": 4096, "invocation": {"module_args": {"path": "/etc/myapp_demo", "state": "directory", "recurse": false, "force": false, "follow": true, "modification_time_format": "%Y%m%d%H%M.%S", "access_time_format": "%Y%m%d%H%M.%S", "unsafe_writes": false, "_original_basename": null, "_diff_peek": null, "src": null, "modification_time": null, "access_time": null, "mode": null, "owner": null, "group": null, "seuser": null, "serole": null, "selevel": null, "setype": null, "attributes": null}}}\r\n', b"（途中省略：SSHセッション終了のdebug出力）\r\nShared connection to 172.18.0.2 closed.\r\n")
（途中省略：一時ディレクトリの削除処理、および2つ目のタスク「検証用設定ファイルを配置する」における同様のSSH接続確立、stat/fileモジュールの転送、sudo昇格の過程）

ok: [target-node1] => {
    "ansible_facts": {
        "discovered_interpreter_python": "/usr/bin/python3.10"
    },
    "changed": false,
    "diff": {
        "after": {
            "path": "/etc/myapp_demo"
        },
        "before": {
            "path": "/etc/myapp_demo"
        }
    },
    "gid": 0,
    "group": "root",
    "invocation": {
        "module_args": {
            "_diff_peek": null,
            "_original_basename": null,
            "access_time": null,
            "access_time_format": "%Y%m%d%H%M.%S",
            "attributes": null,
            "follow": true,
            "force": false,
            "group": null,
            "mode": null,
            "modification_time": null,
            "modification_time_format": "%Y%m%d%H%M.%S",
            "owner": null,
            "path": "/etc/myapp_demo",
            "recurse": false,
            "selevel": null,
            "serole": null,
            "setype": null,
            "seuser": null,
            "src": null,
            "state": "directory",
            "unsafe_writes": false
        }
    },
    "mode": "0755",
    "owner": "root",
    "path": "/etc/myapp_demo",
    "size": 4096,
    "state": "directory",
    "uid": 0
}

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

`-vvv`では、それまでのレベルとは情報の種類が大きく変わります。インベントリのパース過程、`<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible`という接続確立の宣言、実際に発行される完全なSSHコマンドライン（`SSH: EXEC ssh -vvv -C -o ControlMaster=auto ...`）、SSH自体のデバッグ出力（キー交換、認証方式のネゴシエーション）、Python interpreter discoveryの過程、`sftp`によるモジュールファイル転送、`sudo`による権限昇格（`Escalation succeeded`）、そして`invocation.module_args`を含む詳細な実行結果のJSONまで、タスク1つあたりの処理の全過程が可視化されます。

### ■ 検証内容：`-vvvv`での実行

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml -vvvv
```

**▼ 実行結果**

```plaintext
ansible-playbook [core 2.17.14]
  config file = /home/control/iac/docker-lab/ansible.cfg
（途中省略：バージョン情報ブロック）
Using /home/control/iac/docker-lab/ansible.cfg as config file
setting up inventory plugins
Loading collection ansible.builtin from
host_list declined parsing /home/control/iac/docker-lab/inventory.ini as it did not pass its verify_file() method
auto declined parsing /home/control/iac/docker-lab/inventory.ini as it did not pass its verify_file() method
yaml declined parsing /home/control/iac/docker-lab/inventory.ini as it did not pass its verify_file() method
Parsed /home/control/iac/docker-lab/inventory.ini inventory source with ini plugin
Loading callback plugin default of type stdout, v2.0 from /home/control/ansible-env/lib/python3.10/site-packages/ansible/plugins/callback/default.py
（途中省略：callback読み込みのスキップ表示）

PLAYBOOK: test_nested_normal.yml ************************************************************************************************************************************************************
Positional arguments: ../ansible/playbooks/test_nested_normal.yml
verbosity: 4
private_key_file: /home/control/.ssh/id_ed25519
connection: ssh
become_method: sudo
tags: ('all',)
inventory: ('/home/control/iac/docker-lab/inventory.ini',)
forks: 5
1 plays in ../ansible/playbooks/test_nested_normal.yml

PLAY [local-execログ構造デモ（正常系）] *****************************************************************************************************************************************************

TASK [検証用ディレクトリを作成する] *********************************************************************************************************************************************************
task path: /home/control/iac/ansible/playbooks/test_nested_normal.yml:7
<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
<172.18.0.2> SSH: EXEC ssh -vvvv -C -o ControlMaster=auto -o ControlPersist=60s -o StrictHostKeyChecking=no -o 'IdentityFile="/home/control/.ssh/id_ed25519"' -o KbdInteractiveAuthentication=no -o PreferredAuthentications=gssapi-with-mic,gssapi-keyex,hostbased,publickey -o PasswordAuthentication=no -o 'User="ansible"' -o ConnectTimeout=10 -o 'ControlPath="/home/control/.ansible/cp/5aa7fea824"' 172.18.0.2 '/bin/sh -c '"'"'echo ~ansible && sleep 0'"'"''
（途中省略：SSH接続確立、Python interpreter discovery、モジュール転送、sudo昇格の過程。SSHの-vvvvによるdebug出力の内容自体は-vvvと同一で、増分はない）
ok: [target-node1] => {
    "ansible_facts": {
        "discovered_interpreter_python": "/usr/bin/python3.10"
    },
    "changed": false,
    "diff": {
        "after": {
            "path": "/etc/myapp_demo"
        },
        "before": {
            "path": "/etc/myapp_demo"
        }
    },
    "gid": 0,
    "group": "root",
    "invocation": {
        "module_args": {
            "_diff_peek": null,
            "_original_basename": null,
            "access_time": null,
            "access_time_format": "%Y%m%d%H%M.%S",
            "attributes": null,
            "follow": true,
            "force": false,
            "group": null,
            "mode": null,
            "modification_time": null,
            "modification_time_format": "%Y%m%d%H%M.%S",
            "owner": null,
            "path": "/etc/myapp_demo",
            "recurse": false,
            "selevel": null,
            "serole": null,
            "setype": null,
            "seuser": null,
            "src": null,
            "state": "directory",
            "unsafe_writes": false
        }
    },
    "mode": "0755",
    "owner": "root",
    "path": "/etc/myapp_demo",
    "size": 4096,
    "state": "directory",
    "uid": 0
}

（途中省略：2つ目のタスク「検証用設定ファイルを配置する」における同様の実行過程）

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

`-v`から`-vvv`までは、段階を追うごとに新しい種類の情報が追加されていきます。`-v`ではタスク結果のJSON、`-vv`では設定情報とタスクの行番号、`-vvv`ではSSH接続の確立からモジュール転送、権限昇格までの全過程が可視化されます。

一方、`-vvv`から`-vvvv`への変化は、これらとは性質が異なります。今回の検証では、SSH自体のデバッグ出力（`debug1`から`debug3`までの内容）は`-vvv`と`-vvvv`でほぼ同一であり、タスク実行中の情報量そのものは増えていません。これは、Ansibleが内部で呼び出すSSHコマンドの詳細度（`ssh -vvv`または`ssh -vvvv`）が、OpenSSH側の出力としてはすでに`-vvv`の時点で最大詳細度（`debug3`）に達しているためと考えられます。

`-vvvv`で新たに追加されているのは、タスクの実行過程ではなく、Ansible自身の起動直後の診断情報です。インベントリプラグインのセットアップ（`setting up inventory plugins`）、コレクションの読み込み（`Loading collection ansible.builtin from`）、コールバックプラグインの読み込み（`Loading callback plugin default of type stdout`）、そして`verbosity`、`private_key_file`、`connection`、`become_method`、`forks`といった実行時の設定値一覧が、Playbook実行前の段階で新たに表示されます。

つまり、`-vvvv`は「タスクの実行詳細をさらに深掘りする」というより、「Ansible自体がどう起動し、どう設定されているか」という、実行前の診断情報を追加するレベルという性質を持ちます。今回の検証環境、検証内容においては、実際の接続、モジュール実行の詳細を確認する目的であれば`-vvv`で十分であり、`-vvvv`が有効になるのはAnsible自体の起動、設定に関する問題を疑う場合であることが分かりました。

---

[↑ 目次に戻る](#-目次)

---

## 4. 情報量とノイズのトレードオフ

セクション2、3で確認した内容を踏まえ、両方を最大詳細度で同時に有効化した場合に何が起きるかを整理します。

セクション2で確認した通り、`TF_LOG=DEBUG`と`TF_LOG=TRACE`とでは、記録される情報の階層そのものが異なります。`DEBUG`はTerraformコア本体の内部処理（グラフ構築、プラグインプロセスの起動終了）を追うためのログであり、プロバイダーが対象システムに対して実際に何を行ったかは記録されません。Docker daemonとのやり取り（イメージのinspect結果、コンテナ作成結果、コンテナのinspect結果）を確認する必要がある場合、`TF_LOG`は`DEBUG`ではなく`TRACE`まで上げる必要があります。ただし、`TRACE`は行数にして`DEBUG`の2倍以上という情報量になるため、常に`TRACE`を使えばよいわけではありません。

セクション3で確認した通り、Ansible側も同様の構造を持ちます。SSH接続の確立、モジュール転送、権限昇格の過程は`-vvv`の時点ですでにほぼ出尽くしており、`-vvvv`で新たに増えるのはタスク実行の詳細ではなく、Ansible自体の起動、設定に関する診断情報です。接続や実行結果の中身を確認したい場合は`-vvv`で足り、`-vvvv`が必要になるのは、Ansible自体の起動プロセスや設定読み込みを疑う場合に限られます。

この2つの事実を踏まえると、判断基準は次のように整理できます。

```plaintext
Ansible側の接続、モジュール実行の詳細（SSH接続、転送、sudo昇格、実行結果のペイロード）を確認したい
  → -vvvで足りる。-vvvvまで上げる必要はない

Ansible自体の起動、設定読み込み（インベントリプラグイン、コレクション読み込み、verbosity等の設定値）を疑う
  → -vvvvまで上げる

Terraform側でTerraformコアの処理（グラフ構築、リソース依存関係）を確認したい
  → TF_LOG=DEBUGで足りる

Terraform側でプロバイダーが対象システムに対して実際に何を行ったか（今回はDocker daemonとのやり取り）を確認したい
  → TF_LOG=TRACEまで上げる必要がある
```

いずれの場合も、必要以上に高いレベルを指定すると、目的の情報が本来不要な情報に埋もれてしまいます。セクション2で確認した通り、`TF_LOG=TRACE`は同一操作に対して`DEBUG`の2倍以上の行数になり、この中には`tls_private_key`等、今回の目的とは無関係なリソースの処理過程も含まれています。同様に、Ansible側で`-vvvv`を使うと、Ansible自体の起動時診断情報が、確認したいタスクの実行詳細の前に大量に挿入されます。

つまり、「情報を増やせば増やすほど原因が見つけやすくなる」という単純な関係にはなっていません。TerraformとAnsibleのいずれも、あるレベルを境に「同じ種類の情報が増える」のではなく「別の階層の情報が新たに追加される」という構造を持っており、この境目を把握したうえで、確認したい対象がどちらの階層に属するかを見極めることが、詳細度を選ぶ際の基準になります。

次のセクションでは、こうして取得したログファイルから、実際に必要な箇所を`grep`で絞り込む手順を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. grepによるログの絞り込み

セクション2から4で確認した通り、`TF_LOG`、`-vvvv`のいずれも、詳細度を上げるとログの行数が大きく増えます。このセクションでは、取得したログファイルから、実際に必要な箇所を`grep`で絞り込む手順を整理します。

### ■ 検証内容：Ansible側のログをファイルに保存し、タスク単位で絞り込む

まず、`-vvvv`の出力をファイルに保存します。色コードを無効化するため`ANSIBLE_FORCE_COLOR=0`を指定します。

**実行コマンド**

```plaintext
ANSIBLE_FORCE_COLOR=0 ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml -vvvv > ~/iac/docker-lab/logs/ansible_vvvv.log 2>&1
```

保存したログから、まずタスクの開始位置一覧を確認します。

**実行コマンド**

```plaintext
grep -n "TASK \[" ~/iac/docker-lab/logs/ansible_vvvv.log
```

**▼ 実行結果**

```plaintext
35:TASK [検証用ディレクトリを作成する] ********************************************
118:TASK [検証用設定ファイルを配置する] ********************************************
```

2つのタスクが、それぞれ35行目、118行目から始まっていることが分かります。全体を読まなくても、このタスク単位の行番号があれば、該当タスクの箇所へ直接移動できます。

続けて、SSH接続確立の宣言のみを絞り込みます。

**実行コマンド**

```plaintext
grep -n "ESTABLISH SSH CONNECTION" ~/iac/docker-lab/logs/ansible_vvvv.log
```

**▼ 実行結果**

```plaintext
37:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
40:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
44:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
47:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
55:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
58:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
62:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
120:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
123:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
130:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
133:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
141:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
144:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
148:<172.18.0.2> ESTABLISH SSH CONNECTION FOR USER: ansible
```

1つのタスクの中で、SSH接続が複数回確立されていることが分かります。これは、セクション3で確認した通り、1つのファイル配置タスクの裏側で、ディレクトリの存在確認、モジュールファイルの転送、権限変更、モジュール実行、一時ファイルの削除といった複数のSSHセッションが個別に発生しているためです。`ESTABLISH SSH CONNECTION`という行番号だけを先に洗い出しておくことで、1タスクの中に何回分の接続が含まれているかを、ログ全体を読まずに把握できます。

### ■ 検証内容：Terraform側のログから、該当リソースの処理区間を絞り込む

続けて、セクション2で取得済みの`terraform_trace.log`から、実際のリソース作成処理（`applying the planned Create change`）の行番号を特定します。

**実行コマンド**

```plaintext
grep -n "applying the planned Create change" ~/iac/docker-lab/logs/terraform_trace.log
```

**▼ 実行結果**

```plaintext
7106:2026-08-28T00:57:57.211Z [DEBUG] docker_container.targets["target-node2"]: applying the planned Create change
7922:2026-08-28T00:57:59.896Z [DEBUG] local_file.ansible_inventory: applying the planned Create change
7927:2026-08-28T00:57:59.899Z [DEBUG] local_file.group_vars_target_nodes: applying the planned Create change
```

この検索1つで、`docker_container.targets["target-node2"]`だけでなく、`local_file.ansible_inventory`、`local_file.group_vars_target_nodes`という、同じ`apply`で作成された他のリソースの処理開始位置もまとめて把握できます。今回は3リソースのみですが、リソース数が多い環境では、この一覧がそのまま「どのリソースがどの行から処理されているか」の索引になります。

該当行が分かったところで、`target-node2`の処理開始直後の詳細を確認します。

**実行コマンド**

```plaintext
grep -A 5 "applying the planned Create change" ~/iac/docker-lab/logs/terraform_trace.log
```

**▼ 実行結果**

```plaintext
2026-08-28T00:57:57.211Z [DEBUG] docker_container.targets["target-node2"]: applying the planned Create change
2026-08-28T00:57:57.212Z [TRACE] GRPCProvider: ApplyResourceChange
2026-08-28T00:57:57.212Z [TRACE] GRPCProvider: GetProviderSchema
2026-08-28T00:57:57.224Z [TRACE] provider.terraform-provider-docker_v3.0.2: Received request: tf_proto_version=5.3 tf_provider_addr=provider @caller=github.com/hashicorp/terraform-plugin-go@v0.14.3/tfprotov5/tf5server/server.go:805 tf_req_id=138f5a21-054b-9226-1d62-b86ca47d3829 tf_resource_type=docker_container tf_rpc=ApplyResourceChange @module=sdk.proto timestamp=2026-08-28T00:57:57.218Z
2026-08-28T00:57:57.224Z [TRACE] provider.terraform-provider-docker_v3.0.2: Sending request downstream: @module=sdk.proto tf_req_id=138f5a21-054b-9226-1d62-b86ca47d3829 tf_resource_type=docker_container tf_proto_version=5.3 tf_provider_addr=provider tf_rpc=ApplyResourceChange @caller=github.com/hashicorp/terraform-plugin-go@v0.14.3/tfprotov5/internal/tf5serverlogging/downstream_request.go:17 timestamp=2026-08-28T00:57:57.218Z
2026-08-28T00:57:57.224Z [INFO]  provider.terraform-provider-docker_v3.0.2: 2026/08/28 00:57:57 [DEBUG] suppress diff ports: old and new don't have the same length: timestamp=2026-08-28T00:57:57.221Z
--
2026-08-28T00:57:59.896Z [DEBUG] local_file.ansible_inventory: applying the planned Create change
2026-08-28T00:57:59.897Z [TRACE] GRPCProvider: ApplyResourceChange
2026-08-28T00:57:59.897Z [TRACE] GRPCProvider: GetProviderSchema
2026-08-28T00:57:59.897Z [TRACE] GRPCProvider: returning cached schema: EXTRA_VALUE_AT_END=registry.terraform.io/hashicorp/local
2026-08-28T00:57:59.899Z [TRACE] terraform.contextPlugins: Schema for provider "registry.terraform.io/hashicorp/local" is in the global cache
2026-08-28T00:57:59.899Z [DEBUG] local_file.group_vars_target_nodes: applying the planned Create change
2026-08-28T00:57:59.899Z [TRACE] GRPCProvider: ApplyResourceChange
2026-08-28T00:57:59.899Z [TRACE] GRPCProvider: GetProviderSchema
2026-08-28T00:57:59.899Z [TRACE] GRPCProvider: returning cached schema: EXTRA_VALUE_AT_END=registry.terraform.io/hashicorp/local
2026-08-28T00:57:59.913Z [TRACE] provider.terraform-provider-local_v2.9.0_x5: Received request: tf_resource_type=local_file @caller=github.com/hashicorp/terraform-plugin-go@v0.31.0/tfprotov5/tf5server/server.go:931 @module=sdk.proto tf_proto_version=5.11 tf_provider_addr=registry.terraform.io/hashicorp/local tf_req_id=0c871010-cb74-626b-aaa0-38774ae9dc1f tf_rpc=ApplyResourceChange timestamp=2026-08-28T00:57:59.902Z
2026-08-28T00:57:59.915Z [TRACE] terraform.contextPlugins: Schema for provider "registry.terraform.io/hashicorp/local" is in the global cache
```

`-A 5`（該当行から後5行）を指定することで、`applying the planned Create change`の直後にどのプロバイダーが呼ばれ、どのRPC（`ApplyResourceChange`）が発行されたかを、3リソース分まとめて確認できます。`docker_container.targets["target-node2"]`の直後には`terraform-provider-docker_v3.0.2`への`Received request`が続き、`local_file.ansible_inventory`、`local_file.group_vars_target_nodes`の直後にはそれぞれ`terraform-provider-local`のスキーマキャッシュ利用が続いていることが分かります。

### ■ 結果

`grep -n`でまず該当箇所の行番号一覧を洗い出し、そのうえで`grep -A`（あるいは必要に応じて`grep -B`）で前後の文脈を絞り込むという2段階の手順により、数千行規模のログファイルであっても、全体を読み込むことなく該当箇所へ直接たどり着けます。

Ansible側では`TASK \[`でタスクの区切りを、`ESTABLISH SSH CONNECTION`で接続確立のタイミングを、それぞれ独立して洗い出せます。Terraform側では`applying the planned Create change`のような処理区分のキーワードで、複数リソースの処理開始位置をまとめて把握できます。

この「保存する、キーワードで行番号を洗い出す、前後を絞り込む」という一連の流れは、セクション2から4で確認した通り、`TF_LOG=TRACE`や`-vvvv`が持つ情報量の多さを、実務で扱いやすい形に変換するための、共通の手順です。

---

[↑ 目次に戻る](#-目次)

---

## 6. 過去の回への当てはめ

ここまでのセクションで確認した`TF_LOG`と`-vvvv`の実際の挙動を踏まえ、第21回から第29回までの事象が、それぞれどの程度この2つのフラグでカバーできるかを整理します。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** で扱った、`local-exec`経由のAnsible出力がTerraformのエラーブロックに埋没する問題は、`ANSIBLE_LOG_PATH`によるAnsible側のログ分離と、本回セクション2で確認した`TF_LOG_PATH`によるTerraform側のログ分離を組み合わせることで、双方の出力を独立したファイルとして扱えるようになります。この2つの分離の仕組みは、記録される情報の中身こそ異なりますが、標準出力への混在を避けるという構造上の役割は共通しています。

**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** で扱った、複数ネットワークアタッチ時のインターフェース割り当ての逆転は、当時`ip addr`、`ip route`、`journalctl`の`sbJoin`ログ、`terraform state show`という、`TF_LOG`や`-vvvv`とは別の手段の組み合わせによって特定されました。`-vvvv`ではAnsibleがどのIPアドレスに接続したかは確認できますが、なぜそのIPアドレスがコンテナ内部で選ばれたのか（Dockerデーモンの接続順序）という原因そのものは、Ansible側のログの範囲外にあります。同様に、`TF_LOG`はTerraformとプロバイダー間のRPC呼び出しを記録しますが、本回セクション2で確認した通り、`kreuzwerker/docker`プロバイダーは`TRACE`レベルでDocker daemonとのやり取りを記録するものの、これはコンテナの作成、inspect結果であり、ネットワーク接続処理の順序そのものを直接示すものではありません。**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** の問題は、`TF_LOG`と`-vvvv`だけでは完結せず、環境側のログ（`journalctl`等）と組み合わせて初めて原因を特定できる事例です。

**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** で扱った、OS再起動に伴う接続断絶の問題は、検証環境（コンテナ）ではOS再起動という現象自体が成立しないため、本回のセクション2から5で行った実機検証の対象にはなりません。**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** の本文が整理した通り、`local-exec`は子プロセスの内部状態を関知しないため、`reboot`タスクが正常に再接続を待っているのか異常に停止しているのかを、外側からは区別できないという構造上の限界があります。`-vvvv`を使えばAnsible側の再接続試行の様子は見えると考えられますが、これは接続が切れてから戻るまでの`ansible-playbook`プロセス内部の話であり、`local-exec`がその情報を受け取れないという **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** の本質的な問題自体は、デバッグフラグの有無に関わらず解消しません。この回への当てはめは、VM環境を前提とした概念レベルの整理にとどまります。

**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** で扱った、プロキシ環境での`ansible-galaxy collection install`の`Connection refused`エラーは、`TF_LOG`や`-vvvv`を使わずとも、`local-exec`の標準出力にそのまま表示されていました。**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** の検証では、Collectionの取得コマンド自体が`ansible-playbook`より前段で失敗しており、Ansibleの`-vvvv`が効力を持つ範囲（`ansible-playbook`実行時のタスク処理）に到達する前の話です。この場合、`TF_LOG`を上げても得られる情報は増えず、`local-exec`が出力するコマンドの標準出力そのものを確認する方が直接的でした。

これらを整理すると、次のようになります。

|回|問題の所在|TF_LOG／-vvvvの有効性|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|Ansible出力がTerraformのエラーブロックに埋没する|有効。ANSIBLE_LOG_PATHとTF_LOG_PATHの分離が直接の対処になる|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|コンテナ内部のインターフェース割り当ての逆転|限定的。原因特定にはjournalctl等、TF_LOG／-vvvvの範囲外のログが必要|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|local-execが子プロセスの内部状態を関知しない|限定的（概念レベル）。検証環境の制約上、実機での有効性は未検証|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|Collection取得コマンドがPlaybook実行前に失敗する|効果薄。標準出力で足りており、フラグを上げる必要がない|

この一覧から分かるのは、`TF_LOG`と`-vvvv`は原因特定における万能の手段ではないという点です。**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** のように、両者の分離と突き合わせがそのまま対処になる事例がある一方、**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** や **[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)** のように、問題の原因がTerraformとAnsibleそれぞれのログの記録範囲の外側（Dockerデーモンの内部処理、OSレベルの再起動）にある場合や、**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** のように、そもそも詳細化する対象の処理まで到達していない場合には、デバッグフラグを上げること自体が有効な対処にならないことがあります。

次のセクションでは、これらのうち`TF_LOG`と`-vvvv`が有効に機能する場面（**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** に相当するケース)を対象に、両方のログをタイムスタンプで突き合わせる手順を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. ログの相関確認

セクション2から6で確認した内容を踏まえ、`TF_LOG`と`ANSIBLE_LOG_PATH`（Ansible側の分離ログ）を同一の`terraform apply`実行の中で同時に取得し、タイムスタンプを基準に突き合わせる手順を確認します。

### ■ 検証内容：TF_LOGとANSIBLE_LOG_PATHを同時に取得する

`main.tf`の`null_resource.provision`は、セクション2の時点で`ANSIBLE_LOG_PATH=logs/ansible-run.log`を指定する構成に変更済みです。この状態のまま、外側から`TF_LOG`を指定して`apply`を実行します。

**実行コマンド**

```plaintext
TF_LOG=DEBUG TF_LOG_PATH=~/iac/docker-lab/logs/terraform_correlate.log terraform apply -replace="null_resource.provision"
```

**▼ 実行結果**

```plaintext
（途中省略：Planの表示、confirmプロンプト）

null_resource.provision: Destroying... [id=2516569748604518585]
null_resource.provision: Destruction complete after 0s
null_resource.provision: Creating...
null_resource.provision: Provisioning with 'local-exec'...
null_resource.provision (local-exec): Executing: ["/bin/sh" "-c" "ANSIBLE_SSH_RETRIES=0 ANSIBLE_LOG_PATH=logs/ansible-run.log ansible-playbook -i inventory.ini ../ansible/playbooks/test_nested_normal.yml"]

null_resource.provision (local-exec): PLAY [local-execログ構造デモ（正常系）] ****************************************

null_resource.provision (local-exec): TASK [検証用ディレクトリを作成する] ********************************************
null_resource.provision (local-exec): [WARNING]: Platform linux on host target-node1 is using the discovered Python
null_resource.provision (local-exec): interpreter at /usr/bin/python3.10, but future installation of another Python
null_resource.provision (local-exec): interpreter could change the meaning of that path. See
null_resource.provision (local-exec): https://docs.ansible.com/ansible-
null_resource.provision (local-exec): core/2.17/reference_appendices/interpreter_discovery.html for more information.
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): TASK [検証用設定ファイルを配置する] ********************************************
null_resource.provision (local-exec): ok: [target-node1]

null_resource.provision (local-exec): PLAY RECAP *********************************************************************
null_resource.provision (local-exec): target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

null_resource.provision: Creation complete after 7s [id=4098672564564285962]

Apply complete! Resources: 1 added, 0 changed, 1 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

`Provisioning with 'local-exec'...`から`PLAY RECAP`までは、これまでと同様に標準出力（ターミナル）にそのまま表示されました。ここで、`TF_LOG_PATH`で分離取得した`terraform_correlate.log`の側に、この`local-exec`の実行過程がどう記録されているかを確認します。

**実行コマンド**

```plaintext
grep -n "local-exec" ~/iac/docker-lab/logs/terraform_correlate.log
```

**▼ 実行結果**

```plaintext
（結果なし）
```

`local-exec`という文字列が、`terraform_correlate.log`には1件も含まれていません。念のため、`null_resource.provision`のapply開始区間の前後を確認します。

**実行コマンド**

```plaintext
sed -n '5395,5420p' ~/iac/docker-lab/logs/terraform_correlate.log
```

**▼ 実行結果**

```plaintext
2026-08-28T02:57:11.590Z [DEBUG] provider.stdio: received EOF, stopping recv loop: err="rpc error: code = Unavailable desc = error reading from server: EOF"
2026-08-28T02:57:11.592Z [INFO]  provider: plugin process exited: plugin=.terraform/providers/registry.terraform.io/hashicorp/local/2.9.0/linux_amd64/terraform-provider-local_v2.9.0_x5 id=3617
2026-08-28T02:57:11.593Z [DEBUG] provider: plugin exited
2026-08-28T02:57:11.611Z [DEBUG] provider.terraform-provider-null_v3.3.0_x5: Marking Computed attributes with null configuration values as unknown (known after apply) in the plan to prevent potential Terraform errors: @module=sdk.framework tf_provider_addr=registry.terraform.io/hashicorp/null tf_req_id=1098c3a8-2eb9-0454-1ee1-f3d9d15f9796 tf_resource_type=null_resource tf_rpc=PlanResourceChange @caller=github.com/hashicorp/terraform-plugin-framework@v1.19.0/internal/fwserver/server_planresourcechange.go:250 timestamp=2026-08-28T02:57:11.603Z
2026-08-28T02:57:11.613Z [INFO]  Starting apply for null_resource.provision
2026-08-28T02:57:11.616Z [DEBUG] provider.terraform-provider-null_v3.3.0_x5: marking computed attribute that is null in the config as unknown: tf_attribute_path="AttributeName(\"id\")" tf_provider_addr=registry.terraform.io/hashicorp/null @module=sdk.framework tf_req_id=1098c3a8-2eb9-0454-1ee1-f3d9d15f9796 tf_resource_type=null_resource tf_rpc=PlanResourceChange @caller=github.com/hashicorp/terraform-plugin-framework@v1.19.0/internal/fwserver/server_planresourcechange.go:538 timestamp=2026-08-28T02:57:11.604Z
2026-08-28T02:57:11.616Z [DEBUG] null_resource.provision: applying the planned Create change
2026-08-28T02:57:19.159Z [DEBUG] State storage *statemgr.Filesystem declined to persist a state snapshot
2026-08-28T02:57:19.163Z [DEBUG] provider.stdio: received EOF, stopping recv loop: err="rpc error: code = Unavailable desc = error reading from server: EOF"
2026-08-28T02:57:19.167Z [INFO]  provider: plugin process exited: plugin=.terraform/providers/registry.terraform.io/hashicorp/null/3.3.0/linux_amd64/terraform-provider-null_v3.3.0_x5 id=3596
2026-08-28T02:57:19.167Z [DEBUG] provider: plugin exited
```

### ■ 結果

`null_resource.provision: applying the planned Create change`が`02:57:11.616Z`に記録された直後、次のログ行は`State storage ... declined to persist a state snapshot`（`02:57:19.159Z`）まで飛んでいます。この間の約7.5秒間、`terraform_correlate.log`には何も記録されていません。

これは、`local-exec`プロビジョナーの実行過程（コマンドの起動、Ansibleの標準出力、終了コードの確認）が、`TF_LOG`が記録するプロバイダーとのRPC通信のログとは別の経路で処理されていることを示しています。`local-exec`の出力はTerraformの標準出力（ターミナル）に直接流れる仕組みであり、`TF_LOG_PATH`でファイルに分離しても、その分離ログには含まれません。

続けて、この空白区間に対応するAnsible側のログを確認します。`ansible-run.log`は第21回以降の実行がすべて追記されているため、今回の実行分に絞り込みます。

**実行コマンド**

```plaintext
cat -n ~/iac/docker-lab/logs/ansible-run.log
```

**▼ 実行結果（今回の実行分、66〜78行目）**

```plaintext
66  2026-08-28 02:57:13,387 p=3625 u=control n=ansible | PLAY [local-execログ構造デモ（正常系）] ****************************************
67  2026-08-28 02:57:13,414 p=3625 u=control n=ansible | TASK [検証用ディレクトリを作成する] ********************************************
68  2026-08-28 02:57:16,248 p=3625 u=control n=ansible | [WARNING]: Platform linux on host target-node1 is using the discovered Python
69  interpreter at /usr/bin/python3.10, but future installation of another Python
70  interpreter could change the meaning of that path. See
71  https://docs.ansible.com/ansible-
72  core/2.17/reference_appendices/interpreter_discovery.html for more information.
73
74  2026-08-28 02:57:16,250 p=3625 u=control n=ansible | ok: [target-node1]
75  2026-08-28 02:57:16,256 p=3625 u=control n=ansible | TASK [検証用設定ファイルを配置する] ********************************************
76  2026-08-28 02:57:18,920 p=3625 u=control n=ansible | ok: [target-node1]
77  2026-08-28 02:57:18,924 p=3625 u=control n=ansible | PLAY RECAP *********************************************************************
78  2026-08-28 02:57:18,925 p=3625 u=control n=ansible | target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

Terraform側の空白区間（`02:57:11.616Z`から`02:57:19.159Z`まで）と、Ansible側の実行区間（`02:57:13,387`から`02:57:18,925`まで）を突き合わせると、Ansible側の実行が、Terraform側の空白区間の中にすっぽり収まっていることが分かります。

### 手順の整理

ここまでの検証から、`TF_LOG`と`ANSIBLE_LOG_PATH`を組み合わせたログの相関確認は、次の手順で行えます。

**① `TF_LOG_PATH`で、Terraform側のログを分離取得する**

Terraformコアとプロバイダー間のRPC呼び出しが、タイムスタンプ付きで記録されます。

**② `ANSIBLE_LOG_PATH`で、Ansible側のログを分離取得する**

`local-exec`が起動する`ansible-playbook`の実行内容が、独立してタイムスタンプ付きで記録されます。

**③ Terraform側のログで、対象リソース（`null_resource.provision`等）の`applying the planned Create change`の時刻を確認する**

この時刻の直後から、`local-exec`によるプロビジョニングが開始されます。

**④ Terraform側のログで、次に記録が再開する時刻を確認する**

`local-exec`の実行内容自体はTF_LOGに記録されないため、③から④までの区間が、プロビジョニングに要した時間の目安になります。

**⑤ Ansible側のログから、③から④の区間に該当する`PLAY`から`PLAY RECAP`までを特定する**

`ansible-run.log`は実行のたびに追記されるため、対象区間のタイムスタンプに一致する箇所を探す必要があります。

この手順で分かるのは、`TF_LOG`と`ANSIBLE_LOG_PATH`は、互いの詳細を補い合う関係にはないという点です。`TF_LOG`はTerraformとプロバイダーの間で何が起きたかを記録し、`ANSIBLE_LOG_PATH`は`ansible-playbook`の内部で何が起きたかを記録します。`local-exec`が実行されている区間そのものは、`TF_LOG`の側では空白として現れ、その空白の中身を埋めるのが`ANSIBLE_LOG_PATH`側のログです。両者は同じ情報を異なる詳細度で記録しているのではなく、それぞれが担当する区間そのものが異なっており、タイムスタンプという共通の軸を介して初めて、一連の処理の全体像がつながります。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* Terraformの`TF_LOG`環境変数は`TRACE`、`DEBUG`、`INFO`、`WARN`、`ERROR`という段階を持つが、`DEBUG`と`TRACE`とでは記録される情報の階層そのものが異なる。`DEBUG`はTerraformコア本体の内部処理（グラフ構築、プラグインプロセスの起動終了）を記録するのに対し、`TRACE`まで上げて初めて、プロバイダーが対象システム（今回はDocker daemon）に対して実際に何を行ったかというプロバイダー自身のログが表面化する
* Ansibleの`-vvvv`コマンドオプションは`-v`から`-vvvv`まで4段階あるが、`-vvv`の時点でSSH接続の確立、モジュール転送、権限昇格までの過程はほぼ出尽くしている。`-vvvv`で新たに追加されるのは、タスク実行の詳細ではなく、インベントリプラグインの読み込みや実行時設定値といった、Ansible自体の起動、設定に関する診断情報である
* いずれのツールも、詳細度を上げるほど単純に情報が増えるのではなく、あるレベルを境に別の階層の情報が新たに追加されるという構造を持つ。確認したい対象がどちらの階層に属するかを見極めることが、詳細度を選ぶ際の判断基準になる
* `grep -n`で該当箇所の行番号一覧を洗い出し、`grep -A`／`grep -B`で前後の文脈を絞り込むという2段階の手順により、数千行規模のログファイルであっても、全体を読み込むことなく該当箇所へたどり着ける
* **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** から **[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** までの事象を照らし合わせると、`TF_LOG`と`-vvvv`は原因特定における万能の手段ではない。問題の原因がTerraformとAnsibleそれぞれのログの記録範囲の外側にある場合や、そもそも詳細化する対象の処理まで到達していない場合には、デバッグフラグを上げること自体が有効な対処にならないことがある
* `local-exec`プロビジョナーの実行過程は、`TF_LOG`が記録するTerraformコアとプロバイダー間のRPC通信のログには一切含まれない。`TF_LOG_PATH`と`ANSIBLE_LOG_PATH`は、互いの詳細を補い合う関係ではなく、それぞれが担当する区間そのものが異なっており、タイムスタンプという共通の軸を介して初めて、一連の処理の全体像がつながる

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)** では、対象OSに関わらず発生する、Ansible自体の依存関係取得というレイヤーの問題を扱いました。**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)** となる今回は、第3部の最終回として、`TF_LOG`と`-vvvv`という2つのデバッグフラグが実際に何を記録し、何を記録しないかを、実機検証を交えて確認しました。両者が段階的に情報を増やすだけの単純な仕組みではなく、あるレベルを境に記録される情報の階層そのものが変わること、そして`local-exec`の実行過程が`TF_LOG`の記録範囲の外にあることを確認しました。

これで第3部（トラブルシューティング、デバッグ編）は完結です。次回からは第4部（改善、CI/CD自動化編）に入ります。第3部で身につけた「起きた問題をどう特定するか」という視点から、「問題が起きる前にどう防ぐか、どう自動化するか」という視点へと移ります。第4部の初回では、Terraformの`output`を中間データとして抽出し、Ansibleの動的インベントリや変数として渡す、疎結合なパイプライン設計を扱います。

**[次回：第31回：状態出力を介した疎結合なパイプライン設計](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)　｜　[次の記事：【Ansible×Terraform編】第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**

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

### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformのlocal-exec経由でAnsibleのbecomeを実行する際、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|AnsibleのrebootモジュールによるOS再起動時、接続断絶が正常な過程か異常な停止かをTerraformのlocal-execが区別できず、外側のタイムアウトと競合する問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---