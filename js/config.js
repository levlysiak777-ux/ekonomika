// Все настройки сайта в одном месте.
//
// Как добавить актив: скопируйте любую строку в списке markets и поменяйте поля.
//   group  — заголовок группы в таблице
//   name   — как показывать название
//   hint   — короткая подсказка под названием (одна фраза)
//   symbol — код актива на Yahoo Finance: найдите актив на finance.yahoo.com,
//            код стоит в адресе страницы (например ^GSPC, PKN.WA, EURPLN=X, BTC-USD)
//   kind   — "index" (без валюты), "fx" (4 знака после запятой), "commodity",
//            "crypto" (изменение за день = за 24 часа), "stock"

export const CONFIG = {
  // Адрес вашего Cloudflare Worker, например "https://ekonomika.ваше-имя.workers.dev".
  // Пусто — сайт берёт котировки через локальный server.js (/api).
  quotesProxy: "",

  // Как часто обновлять цены, пока вкладка открыта.
  refreshSeconds: 60,

  markets: [
    { group: "Индексы", name: "S&P 500", hint: "500 крупнейших компаний США", symbol: "^GSPC", kind: "index" },
    { group: "Индексы", name: "Nasdaq", hint: "Технологические компании США", symbol: "^IXIC", kind: "index" },
    { group: "Индексы", name: "Dow Jones", hint: "30 старейших крупных компаний США", symbol: "^DJI", kind: "index" },
    { group: "Индексы", name: "WIG20", hint: "20 крупнейших компаний Варшавской биржи", symbol: "WIG20.WA", kind: "index" },

    { group: "Валюты", name: "USD/PLN", hint: "Сколько злотых стоит 1 доллар", symbol: "PLN=X", kind: "fx" },
    { group: "Валюты", name: "EUR/PLN", hint: "Сколько злотых стоит 1 евро", symbol: "EURPLN=X", kind: "fx" },
    { group: "Валюты", name: "EUR/USD", hint: "Сколько долларов стоит 1 евро", symbol: "EURUSD=X", kind: "fx" },

    { group: "Сырьё", name: "Золото", hint: "Цена унции (31,1 г) в долларах", symbol: "GC=F", kind: "commodity" },
    { group: "Сырьё", name: "Нефть Brent", hint: "Цена барреля (159 л) в долларах", symbol: "BZ=F", kind: "commodity" },

    { group: "Криптовалюты", name: "Биткоин", hint: "Самая крупная криптовалюта", symbol: "BTC-USD", kind: "crypto" },
    { group: "Криптовалюты", name: "Эфир", hint: "Вторая по размеру криптовалюта", symbol: "ETH-USD", kind: "crypto" },
  ],
};
