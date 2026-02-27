import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "@/locales/en.json"
import zh from "@/locales/zh.json"

const LANGUAGE_KEY = "verybot-language"

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  lng: localStorage.getItem(LANGUAGE_KEY) ?? "en",
  fallbackLng: "en",
  interpolation: { escapeValue: false },
})

export default i18n
