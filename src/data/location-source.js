const BETTERMAP_TABLES = {
  'oracle-stone': '/Game/DataTable/Treasurebox/DT_OracleStoneConfig',
  'gift-21': '/Game/DataTable/Treasurebox/DT_TreasureboxConfig',
  monster: '/Game/DataTable/DT_MonsterManualConfig',
  'city-crime': '/Game/DataTable/CityEvent/DT_CityEventLibrary',
}

export function betterMapLocationSource(kind, point, groupId) {
  return {
    method: 'bettermap-export',
    asset: BETTERMAP_TABLES[kind],
    rowId: kind === 'monster' ? groupId : point.rowId,
    coordinateField: kind === 'monster' ? 'ArrayWorldLocation' : kind === 'city-crime' ? 'SendRewardCenter' : 'Location',
    level: point.level,
    ...(kind === 'city-crime' ? { offset: {
      asset: '/Game/DataTable/CityEvent/DT_CityEventUIConfig',
      rowId: 'Crimes',
      field: 'UIData.FatherInfo.MapIconOffset',
    } } : {}),
  }
}
