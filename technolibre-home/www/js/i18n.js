import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

i18next
  .use(initReactI18next)
  .init({
    lng: navigator.language, // Détecter la langue de l'utilisateur
    resources: {
      en: {
        translation: {
          title_app: 'Technolibre\'s Home',
        },
      },
      fr: {
        translation: {
          title_app: 'Maison de Technolibre',
        },
      },
    },
  });

document.getElementById('title_app').textContent = i18next.t('title_app');
