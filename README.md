# MaaNTE 在线地图工具

基于 Vue 3、Leaflet 和 Vite 的本地交互式地图。

## 启动

```powershell
npm install
npm run dev
```

开发服务器默认运行在 `http://127.0.0.1:5173`

## 本地数据

地图配置维护在 `src/data/map-data.json`，点位按分类存放在 `src/data/locations/*.json`，不再从第三方接口同步。配置文件包括：

- `map`：底图像素尺寸、瓦片尺寸、世界原点像素与缩放比例。
- `map.tileUrl`：MapSource 仓库的瓦片模板。生产构建默认读取
  `https://raw.githubusercontent.com/Maa-NTE/MapSource/main/tiles/{z}/{x}/{y}.jpg`；
  本地开发通过 Vite 映射到同一份 sibling `MapSource/tiles`，可用
  `VITE_MAP_TILE_URL` 覆盖。
- `categories`：本地分类定义。分类可通过 `isHidden: true` 暂时从浏览界面隐藏。
- `locationFiles`：分类点位文件清单。每个文件为点位数组，支持多类型、描述、标签和截图。
- `routes`：路线与有序路段。

例如谕石位于 `src/data/locations/oracle-stone.json`，21 的赠礼位于 `gift-21.json`，
羽偶位于 `feather-doll.json`。一个多类型点位只存放在 `types[0]` 对应的文件中，其他类型引用保持不变。
新增分类时，编辑接口和合并脚本会创建对应的分类文件并更新清单；前端和开发接口在读取时汇总，
不再把全部点位写回单个 JSON。

历史导入快照已经通过 Python 脚本清洗。脚本也可以重复执行，用于删除误加入的冗余字段：

```powershell
npm run clean:locations
```

## 编辑地图

点击页面右上角的“编辑地图”：

1. 点击地图空白处新建点位。
2. 在点位详情中编辑或删除点位。
3. 一个点位可以选择多个类型，也可以添加可复用的自定义类型。
4. 点位可以上传多张截图，详情页支持预览。
5. 路线面板可以新建路线，再依次点击标点建立路段。

图片会先在浏览器内暂存，保存点位时按点位 ID 和图片内容哈希生成稳定路径。通过本地开发服务器编辑时，点位会写回 `src/data/locations/` 下对应的分类文件，截图会写入 `public/images/locations/<点位 ID>/`；取消表单或移除尚未保存的图片不会产生孤儿文件。

保存或删除点位后，本次会话的变更会累计到编辑工具栏的“导出点位修改包”中。生产构建和 GitHub Pages 等静态部署中，点位表单的“确认”只会暂存当前修改；可以连续编辑多个点位，最后从顶部工具栏一次性导出修改包。导出的 ZIP 同时包含 `location-changes.json` 和本次修改引用的图片，可直接交给仓库合并脚本处理，不依赖服务端上传接口。开启编辑模式后可导入旧版点位 JSON 或新版 ZIP 修改包。路线编辑仍保存在浏览器本地存储中，并可通过路线面板导入或导出 JSON 文件。

在仓库根目录合并修改包：

```powershell
npm run merge:locations -- C:/Users/owo/Downloads/MaaNTE-location-changes-2026-07-16.zip
git status --short
```

合并脚本会先校验图片路径、格式、大小和 SHA-256，再统一更新地图数据与 `public/images/locations/`。旧版 `location-changes.json` 仍可继续合并；使用 `--dry-run` 可以只检查和查看统计而不写入文件。

如果删除的是本次会话刚创建的点位，该点位会直接从累计修改中移除，不生成删除记录；仅由该点位使用的本次新建分类也会一并移除。

探索进度保存在浏览器本地存储中。页面右上角的探索进度区域支持导入或导出完成记录 JSON，便于在不同浏览器或设备间迁移。

在分类和“区域筛选”中分别选择一个或多个标签、区域，即可直接点击“一键完成”，将所有已选区域内命中任一已选标签的点位标记为已完成。点位会自动去重；开启“传送点保持开启”时附带显示的传送点不会计入标签选择。

隐藏分类仍然会出现在编辑表单的“类型（可多选）”列表中，用于继续维护点位数据。隐藏分类不会出现在浏览侧边栏、地图标记、点位详情标签和探索进度中。各分类的当前展示状态以 `isHidden` 字段为准。

编辑表单中的“搜索关键词（可选）”用于补充搜索命中词，不是点位类型。关键词使用英文逗号分隔，不会出现在分类侧边栏中。

## 从 BetterMap 更新点位

在 BetterMap 0.1.19 及以上版本进入游戏主场景，点击「分类导出全部点位」。
插件会在运行包的 `Anomaly/state/plugins/b1ank.better-map/` 直接生成分类文件，无需手动创建子目录：
谕石、21 的赠礼、城市违规行径各一个文件，每种怪物单独一个文件。`index.json` 只记录本次分类清单与可用状态。

在本仓库根目录执行：

```powershell
npm run import:bettermap -- "<运行包>/Anomaly/state/plugins/b1ank.better-map" --dry-run
npm run import:bettermap -- "<运行包>/Anomaly/state/plugins/b1ank.better-map"
npm run merge:locations -- output/imports/bettermap --dry-run
npm run merge:locations -- output/imports/bettermap
```

需要完全以游戏导出为准时，在转换命令中加 `--authoritative`：

```powershell
npm run import:bettermap -- "<运行包>/Anomaly/state/plugins/b1ank.better-map" --authoritative --dry-run
npm run import:bettermap -- "<运行包>/Anomaly/state/plugins/b1ank.better-map" --authoritative
npm run merge:locations -- output/imports/bettermap
```

此模式会导入每一个游戏点位，按最近的一一对应关系复用旧记录的名称、截图和备注，
并删除本次已导出分类中未匹配的旧点位。未导出的分类、不可用的数据表以及其他类型的点位保留。
多类型旧点位若还属于未导出的分类，会保留那些类型。坐标始终使用游戏导出的原始 X/Y/Z。

也可以只转换某个分类，例如 `b1ank.better-map/oracle-stone.json`；合并时也可以只选择
`output/imports/bettermap/oracle-stone.json`。转换结果按地图分类分文件，目录中的 `index.json`
只列出本次修改包。合并目录以清单为准，不会误合并上次遗留的其他分类文件。

原始 X/Y/Z 为 UE 世界坐标，单位厘米，不需要底图像素转换。导入只选择主世界点位，
默认模式保留旧点位，不根据账号完成状态筛选。首次按分类及邻近坐标匹配已有点位，默认距离 1700 厘米，
可用 `--match-distance <厘米>` 调整；匹配成功后保留旧 ID、名称、描述、截图、区域与标签，更新坐标并记录 `betterMapId`。
后续优先按该标识匹配。多个候选或多个源点争用同一个旧点位时会跳过并在统计的 `ambiguous` 中报告，需人工核对。

怪物先按 `src/data/bettermap-category-map.json` 中的稳定图鉴行名匹配现有分类，再按图鉴名称匹配；
新增名称生成单独分类前，必须先在映射中配置 `id` 和对应的 `iconUrl`，避免添加没有图标的分类。
映射包含贩售机附电灵、唱片机附电灵和 ReroRero 电话亭与原分类的对应关系。
游戏语言不同或名称有差异时，
可以通过 `--category-map <JSON文件>` 显式指定映射，内容为 `{"图鉴行名": "现有分类ID"}`。
导出数据表不可用时会显示在 `unavailable` 中；城市违规事件是可能发生位置，并非实时事件状态。
新点位的区域默认“全地图”，可在地图编辑器中补充说明、截图和区域。

城市违规行径使用游戏地图的原生手铐图标 `YH_UI_Mapicon_096`；低语种、空铠甲分别使用怪物图鉴的
`mon_01`、`mon_20` 头像，资源放在 `public/icons/`，新增分类的图标路径同时登记在分类映射中。

“传送点”还包含从当前游戏包读取的 Boss 入口：7 个世界 Boss 和 4 个异象巡礼周常 Boss，
包括讨债人、贵腐巢母。点位来自 `DT_TeleportPoint` 的主世界入口 `Transform.Translation`，
名称与图标按 `DT_MonsterManualConfig`、`DT_CloneEnter` 对应；不使用副本内的传送落点。
每个 Boss 单独维护分类点位文件和原生头像。清洗工具保留已有游戏坐标的完整数值精度。

其他分类也已按 FModel MCP 从当前游戏包读取的数据更新，坐标保留原始 X/Y/Z，
用 `gameDataId` 保存数据表行名或刷怪器身份，编辑和清洗时保留这个标识：

- `DT_RandomItem` 关联刷新类型与掉落表：618 处钱包、1,024 处杂物。它们是刷新候选位置，每轮只启用部分点位。
- `DT_EnvirTreasureBoxConfig`：130 处魔术师的馈赠、68 处避役的包裹、10 处手办、12 处家具、63 处特级猎人攻略。
- `DT_MapExploreViewPointConfig`：39 处打卡、10 处飞车打卡，分别维护分类与图标。
- `DT_Vision`：45 处有固定坐标的异象委托；3 个移动章鱼拖车委托的坐标为空，未生成固定标记。
- `DT_QuestFixedMapIconData`：23 处支线任务标记；两个短信触发任务没有固定坐标，未生成标记。
- `DT_TeleportPoint`：18 处电话亭、6 座塔、魔女之家与粉爪总行，使用入口坐标。
- 主世界地图分块中的 `HTAISpawnManager`：58 处包包蚊出生位置，包含条件事件中的不同出生位置。

旧“街头正义”筛选复用 97 处城市违规事件记录，一个点位同时带两个类型，避免重复存放坐标。
新增图标均直接使用游戏原始 PNG；包包蚊未找到可确认对应的原生头像，暂保留现有图标。

所有点位均带 `source` 对象，来源信息保存在各分类 JSON 中，不混入点位描述：

```json
"source": {
  "method": "fmodel-mcp",
  "asset": "/Game/DataTable/MapExplore/DT_MapExploreViewPointConfig",
  "rowId": "WP_00101",
  "coordinateField": "IconTransform.Translation",
  "level": "XL_map_bigworld_test"
}
```

`method` 为 `fmodel-mcp`、`bettermap-export` 或手工新增时的 `manual`。
`asset` 是 UE 资产路径，`rowId` 是原生行名，`coordinateField` 指明原始坐标字段。
地图分块里的刷怪器改用 `objectName` 和 `actorGuid` 定位对象，坐标字段包含波次、条目和出生位置索引。
城市违规事件另记录图标坐标偏移的来源 `offset`。`betterMapId` / `gameDataId` 用于稳定匹配已有记录。
后续 BetterMap 导入会自动写入来源；编辑、分类导出、合并与清洗都会保留来源字段。

## 开发说明

### 目录结构

- `src/App.vue`：地图界面、筛选、编辑器和路线交互。
- `src/data/map-data.json`：地图配置、分类、路线和点位文件清单。
- `src/data/locations/*.json`：按主分类维护的点位数组。
- `scripts/lib/map-data-store.mjs`：开发接口和导入脚本共用的分类文件读写。
- `src/data/locations.js`：地图坐标转换。
- `vite.config.js`：Vite 配置，以及仅在开发服务器中启用的本地写入接口。

### 分类字段

每个 `categories` 条目包含以下字段：

- `id`：稳定标识，点位通过 `types` 数组引用它。
- `group`、`label`：侧边栏分组和显示名称。
- `icon`、`color`：地图标记样式。
- `isDefault`：保留的导入字段。
- `isHidden`：可选。设为 `true` 时仅在编辑器中保留，不进入浏览界面。

暂时隐藏分类时不要删除分类或点位数据；设置 `isHidden: true` 即可。恢复展示时移除该字段或改为 `false`。

通过编辑器添加的自定义类型会写入 `categories`，并自动勾选到当前点位。新增时必须填写稳定的类型 ID，并可以选择已有标记大类；也可以填写“新建大类（可选）”，将类型归入新的侧边栏分组。若填写的 ID 已存在，编辑器会依次追加 `-2`、`-3` 等数字后缀。后续编辑其他点位时可以直接复用。

### 本地接口

`npm run dev` 会通过 Vite 中间件提供仅用于本地编辑的接口：

- `GET /api/map-data`：汇总最新配置和分类点位文件。
- `POST /api/map-data`：将点位按分类写回文件，并更新配置清单。
- `POST /api/location-image?path=...`：校验内容哈希后把点位截图写入 `public/images/locations/`。
- `DELETE /api/location-image?path=...`：清理本次会话已移除且不再使用的点位截图。
- `POST /api/upload-image`：保留的旧版截图上传接口。

`npm run build` 生成的静态站点不会直接写仓库文件，而是生成可由 `merge:locations` 合并的修改包。

### 修改流程

1. 运行 `npm install` 安装依赖。
2. 运行 `npm run dev`，在浏览器中检查交互和编辑写入。
3. 修改分类或点位后，按需运行 `npm run clean:locations` 统一数据格式。
4. 提交前运行 `npm run build`、`npm run qa:location-bundle`、`npm run qa:static-location-bundle` 和 `npm run qa`。

## 坐标与扩图

点位和路线持久化为游戏真实坐标 `x/y`。渲染时使用
`src/data/navi-coordinate-calibration.json` 中的游戏原生地图中心与覆盖范围投影：

```text
pixelX = ((gameX - centerX) / sizeX + 0.5) * sourceWidth
pixelY = ((gameY - centerY) / sizeY + 0.5) * sourceHeight
```

当前主世界中心为 `(0, 80000)`，X/Y 覆盖范围均为 `796461.8` 游戏厘米，
参数来自 `DT_LevelMiniMap.XL_map_bigworld_test.MiniMapBackgroundRenderData`。
采用原生参数消除旧三点标定中的整体微小偏移。标定文件的 `source` 记录参数来源，
历史像素帧仍使用各自的标定数据转换。定位服务和路线下发使用
`13056 × 13056` 的 MapLocator 像素坐标；Leaflet 坐标仅用于页面内部渲染。

坐标转换关系如下：

```text
游戏真实坐标 ⇄ 标定像素坐标 ⇄ Leaflet CRS.Simple 坐标
```

更新标定文件后，点位、路线、鼠标坐标和 WebSocket 路径点会统一使用新的变换。
本次 `13-bigworldmap-1` 相对旧 44×44 图从左侧扩 1 个瓦片、顶部扩 7 个瓦片，
右侧扩 6 个瓦片，底部不变。对未变化区域做像素配准后，旧图内容在新图中的有效
偏移约为 `(466, 3477)` 全分辨率像素，即定位坐标原点增加 `(233, 1738)`；
`mapLocatorSourceWidth/Height` 从 `11264` 更新为 `13056`。已有真实坐标未修改。

原始大图和压缩分层瓦片位于独立的
[`Maa-NTE/MapSource`](https://github.com/Maa-NTE/MapSource) 仓库，Map 仓库只保留
瓦片地址引用。`13-bigworldmap-2` 仅用于本地拼图对比，输出到 `output/map_bigworld_13-2.png`，
不会进入 Git。

## 验证

```powershell
npm run build
npm run qa:location-bundle
npm run qa:static-location-bundle
npm run qa
```

## MaaNTE 实时定位

页面默认连接 `ws://127.0.0.1:14514`，接收 MaaNTE 的 Navi 定位状态，并在地图上展示玩家位置箭头、像素坐标和朝向角度。定位消息包含有效游戏原始 `x/y` 时，箭头会按当前地图标定重新换算；旧版只发送像素且不带帧信息时，会按扩图前历史标定帧转换，避免地图更新后箭头停留在旧底图位置。

在 MaaNTE 中运行 `MapLocator.json` 提供的 `NaviWebSocket` 节点即可同时启动 NCC 定位、方向预测和本地广播。

需要使用其他地址时，在构建前设置 `VITE_MAANTE_NAVI_WEBSOCKET_URL`。消息格式如下：

完整的双向消息、路线控制和错误响应定义见 [地图站 WebSocket 接口文档](docs/websocket-api.md)。

```json
{
  "type": "navi-state",
  "version": 1,
  "position": {
    "pixelX": 5788,
    "pixelY": 8902,
    "score": 0.82,
    "mode": "local",
    "sourceWidth": 13056,
    "sourceHeight": 13056,
    "coordinateFrame": "map-2026-08"
  },
  "angle": 123.4,
  "angleConfidence": 0.96,
  "timestamp": 1770000000.0
}
```
