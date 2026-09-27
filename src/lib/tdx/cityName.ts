const names: Record<string, string> = {
  Taipei: "臺北", NewTaipei: "新北", Taoyuan: "桃園", Taichung: "台中", Tainan: "臺南", Kaohsiung: "高雄",
  Keelung: "基隆", Hsinchu: "新竹市", HsinchuCounty: "新竹縣", MiaoliCounty: "苗栗", ChanghuaCounty: "彰化",
  NantouCounty: "南投", YunlinCounty: "雲林", Chiayi: "嘉義市", ChiayiCounty: "嘉義縣", PingtungCounty: "屏東",
  YilanCounty: "宜蘭", HualienCounty: "花蓮", TaitungCounty: "臺東", PenghuCounty: "澎湖", KinmenCounty: "金門",
  LienchiangCounty: "連江",
};

export const cityName = (city?: string | null) => city ? names[city] ?? city : "";
