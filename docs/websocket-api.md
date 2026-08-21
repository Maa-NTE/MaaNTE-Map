# 地图站 WebSocket 接口文档

本文档描述 MaaNTE 地图站与导航服务之间的 WebSocket 协议。消息均使用 UTF-8 编码的 JSON 文本。

## 1. 连接信息

| 项目 | 说明 |
| --- | --- |
| 默认地址 | `ws://127.0.0.1:14514` |
| 可用协议 | `ws`、`wss` |
| 认证 | 当前地图站未发送认证信息 |
| WebSocket 子协议 | 无 |
| 消息格式 | 每个 WebSocket 文本帧包含一个 JSON 对象 |

构建时可通过环境变量覆盖默认地址：

```env
VITE_MAANTE_NAVI_WEBSOCKET_URL=ws://127.0.0.1:14514
```

用户也可以在地图站设置中修改协议、主机和端口。

地图站仅在开启“实时定位”后建立连接。连接异常关闭时，客户端每隔 2 秒尝试重连。当前协议未定义应用层心跳，服务端可使用标准 WebSocket Ping/Pong。

## 2. 坐标约定

定位和路线消息使用像素坐标：

- 原点位于图片左上角。
- `pixelX` 向右递增。
- `pixelY` 向下递增。
- `sourceWidth` 和 `sourceHeight` 表示坐标所基于的图片尺寸。
- 地图站当前发送路线时使用 `13056 × 13056` 定位坐标系。

地图站内部的点位和路线使用游戏真实 `X/Y` 坐标保存。发送路线前，地图站根据
`src/data/navi-coordinate-calibration.json` 中的标定点计算二维仿射变换，将真实坐标
转换为本协议使用的像素坐标。该变换可同时处理平移、缩放、轻微旋转和剪切。

服务端发送定位状态时，建议始终携带坐标系尺寸。地图站会按以下方式换算到当前底图：

```text
mapX = pixelX × mapWidth / sourceWidth
mapY = pixelY × mapHeight / sourceHeight
```

WebSocket 可以同时传输游戏原始 XYZ 和 MapLocator 像素坐标。像素坐标用于地图渲染，
原始 XYZ 用于精确显示；旧服务端只发送像素坐标时仍然兼容。

## 3. 消息一览

| 消息类型 | 方向 | 用途 |
| --- | --- | --- |
| `navi-state` | 服务端 → 地图站 | 推送实时位置、朝向和路线状态 |
| `navi-route-set` | 地图站 → 服务端 | 设置路线，可选择立即开始 |
| `navi-route-start` | 地图站 → 服务端 | 开始或继续当前路线 |
| `navi-route-stop` | 地图站 → 服务端 | 暂停当前路线 |
| `navi-route-clear` | 地图站 → 服务端 | 清空当前路线 |
| `navi-route-ack` | 服务端 → 地图站 | 确认路线命令并返回路线状态 |
| `navi-error` | 服务端 → 地图站 | 返回业务错误 |

未知消息类型会被地图站忽略。

## 4. 服务端推送消息

### 4.1 实时导航状态 `navi-state`

服务端使用该消息持续推送定位状态。

```json
{
  "type": "navi-state",
  "version": 1,
  "position": {
    "x": -134394.56,
    "y": 199913.53,
    "z": 11416.17,
    "pixelX": 4323,
    "pixelY": 8488,
    "score": 0.82,
    "mode": "local",
    "sourceWidth": 13056,
    "sourceHeight": 13056
  },
  "angle": 123.4,
  "angleConfidence": 0.96,
  "timestamp": 1770000000.0,
  "route": {
    "status": "running",
    "currentIndex": 2,
    "waypoints": [
      { "pixelX": 5700, "pixelY": 8800 },
      { "pixelX": 5800, "pixelY": 9000 }
    ]
  }
}
```

顶层字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | 固定为 `navi-state` |
| `version` | number | 是 | 当前只处理版本 `1` |
| `position` | object/null | 否 | 当前定位；无有效定位时可为 `null` |
| `angle` | number/null | 否 | 朝向角度，单位为度；无结果时为 `null` |
| `angleConfidence` | number | 否 | 朝向置信度；缺省或非法值按 `0` 处理 |
| `timestamp` | number | 否 | 状态时间戳；建议使用 Unix 时间戳，当前地图站不读取该字段 |
| `route` | object/null | 否 | 当前路线状态；缺省时保留上一次路线状态 |

`position` 字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `x` | number | 否 | 游戏原始 X 坐标 |
| `y` | number | 否 | 游戏原始 Y 坐标 |
| `z` | number | 否 | 游戏原始 Z 坐标，用于页面坐标显示 |
| `pixelX` | number | 条件必填 | X 像素坐标；未提供时必须提供有效 `x/y` |
| `pixelY` | number | 条件必填 | Y 像素坐标；未提供时必须提供有效 `x/y` |
| `sourceWidth` | number | 建议 | 坐标源宽度，必须大于 `0` |
| `sourceHeight` | number | 建议 | 坐标源高度，必须大于 `0` |
| `score` | number | 否 | 定位置信度，当前地图站不读取 |
| `mode` | string | 否 | 定位模式，当前地图站不读取 |

处理规则：

- `type` 不是 `navi-state` 或 `version` 不是 `1` 时，地图站忽略消息。
- 新格式建议同时发送游戏原始 `x/y/z` 和像素 `pixelX/pixelY`。页面优先显示服务端提供的原始 XYZ。
- 旧格式只发送 `pixelX/pixelY` 时仍然兼容；地图站会通过标定矩阵反算游戏 X/Y，Z 显示为空。
- 未发送像素坐标但提供有效 `x/y` 时，地图站会通过标定矩阵计算像素位置并正常渲染定位箭头。
- 像素坐标和游戏 `x/y` 均无效时，本次状态视为无有效位置并隐藏定位箭头。
- `sourceWidth` 或 `sourceHeight` 缺失、非法或不大于 `0` 时，地图站使用 MapLocator 基准尺寸 `13056 × 13056`。
- `angle` 可以是任意有限数值，地图站会按 360° 周期平滑显示。

### 4.2 路线命令确认 `navi-route-ack`

服务端可在处理路线命令后返回确认消息。

```json
{
  "type": "navi-route-ack",
  "message": "路线已设置并开始导航",
  "route": {
    "status": "running",
    "currentIndex": 1,
    "waypoints": [
      { "pixelX": 5700, "pixelY": 8800 },
      { "pixelX": 5800, "pixelY": 9000 }
    ]
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | 固定为 `navi-route-ack` |
| `message` | string | 否 | 地图站向用户显示的提示文本 |
| `route` | object | 否 | 最新路线状态 |
| `route.status` | string | 建议 | 路线状态，例如 `running`、`stopped`、`idle` |
| `route.currentIndex` | number | 建议 | 当前路径点索引或进度值 |
| `route.waypoints` | array | 建议 | 当前路径点列表；地图站使用其长度显示总进度 |

`route` 对象允许附加扩展字段。当前地图站只直接展示 `status`、`currentIndex` 和 `waypoints.length`。

### 4.3 错误消息 `navi-error`

```json
{
  "type": "navi-error",
  "message": "路径点为空",
  "code": "EMPTY_WAYPOINTS"
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | 固定为 `navi-error` |
| `message` | string | 否 | 面向用户的错误说明 |
| `code` | string | 否 | 机器可读错误码；当前地图站不读取 |

## 5. 地图站发送消息

### 5.1 设置路线 `navi-route-set`

```json
{
  "type": "navi-route-set",
  "sourceWidth": 13056,
  "sourceHeight": 13056,
  "start": true,
  "waypoints": [
    {
      "pixelX": 5700.125,
      "pixelY": 8800.5
    },
    {
      "pixelX": 5800,
      "pixelY": 9000
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `type` | string | 是 | 固定为 `navi-route-set` |
| `sourceWidth` | number | 是 | 路径点坐标源宽度，当前为 `13056` |
| `sourceHeight` | number | 是 | 路径点坐标源高度，当前为 `13056` |
| `start` | boolean | 是 | `true` 表示设置后立即开始，`false` 表示只设置路线 |
| `waypoints` | array | 是 | 路径点列表，至少包含一个元素 |
| `waypoints[].pixelX` | number | 是 | X 像素坐标，地图站最多保留 3 位小数 |
| `waypoints[].pixelY` | number | 是 | Y 像素坐标，地图站最多保留 3 位小数 |

地图站在发送前会移除相邻且坐标完全相同的重复路径点。

服务端处理建议：

1. 校验坐标系尺寸和路径点列表。
2. 用新路线完整替换旧路线。
3. 根据 `start` 更新运行状态。
4. 返回 `navi-route-ack`；校验失败时返回 `navi-error`。

### 5.2 开始或继续路线 `navi-route-start`

```json
{
  "type": "navi-route-start"
}
```

服务端应开始或继续执行已设置的路线。若不存在可执行路线，建议返回 `navi-error`。

### 5.3 暂停路线 `navi-route-stop`

```json
{
  "type": "navi-route-stop"
}
```

服务端应暂停当前路线，并保留路线及当前进度，以便后续继续。

### 5.4 清空路线 `navi-route-clear`

```json
{
  "type": "navi-route-clear"
}
```

服务端应停止导航、清空路径点并重置路线进度。

## 6. 推荐状态值

协议当前未强制枚举 `route.status`。为保证不同服务端实现显示一致，建议使用：

| 状态 | 含义 |
| --- | --- |
| `idle` | 无路线或路线已清空 |
| `ready` | 路线已设置但尚未开始 |
| `running` | 正在导航 |
| `stopped` | 已暂停 |
| `completed` | 路线已完成 |
| `error` | 路线执行异常 |

## 7. 兼容性与错误处理

- 服务端应忽略无法识别的附加字段，便于协议向后扩展。
- 地图站会忽略无法解析的 JSON、未知消息类型和不支持的 `navi-state` 版本，不会主动关闭连接。
- 当前只有 `navi-state` 携带并校验 `version` 字段；路线命令没有版本字段。
- 服务端不应依赖 `timestamp`、`score`、`mode` 或 `code` 被当前地图站处理，它们属于兼容和诊断字段。
- 建议服务端在每次路线状态变化后返回 `navi-route-ack`，并在后续 `navi-state` 中持续携带最新 `route` 状态。

## 8. 最小服务端交互示例

```text
地图站  -> 服务端：navi-route-set
服务端  -> 地图站：navi-route-ack（status = running）
服务端  -> 地图站：navi-state（持续推送位置和路线进度）
地图站  -> 服务端：navi-route-stop
服务端  -> 地图站：navi-route-ack（status = stopped）
地图站  -> 服务端：navi-route-start
服务端  -> 地图站：navi-route-ack（status = running）
地图站  -> 服务端：navi-route-clear
服务端  -> 地图站：navi-route-ack（status = idle）
```
