// hook-form.js v1.0.0
// https://github.com/USER/hook-form

(function() {
  const config = {
    webhook: null,
    timeout: 10000 // таймаут 10 сек
  };

  // Флаг для отслеживания инициализации
  const initialized = new Set();

  // Работа с куками
  const cookies = {
    set(name, value, days = 30) {
      const maxAge = days * 24 * 60 * 60;
      document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAge}; SameSite=Lax`;
    },
    get(name) {
      const value = `; ${document.cookie}`;
      const parts = value.split(`; ${name}=`);
      if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
      return '';
    }
  };

  // Валидация webhook URL
  function isValidWebhookUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (e) {
      return false;
    }
  }

  // Получить Google Analytics Client ID
  // Сначала пытаемся получить через gtag API, затем из куки
  function getGAClientId() {
    // Попробуем получить через Google Analytics API если доступна
    if (typeof window.gtag === 'function') {
      try {
        let clientId = '';
        window.gtag('get', 'client_id', (id) => {
          clientId = id;
        });
        if (clientId) return clientId;
      } catch (e) {
        // Если API недоступна, продолжаем к чтению куки
      }
    }

    // Получаем из куки Google Analytics 4 (_ga)
    const ga4Match = document.cookie.match(/_ga=GA[\d.]+\.([\d.]+)/);
    if (ga4Match && ga4Match[1]) {
      return ga4Match[1];
    }

    // Резервный вариант - ищем в куки _ga целиком
    const gaCookie = document.cookie
      .split('; ')
      .find(row => row.startsWith('_ga='));
    if (gaCookie) {
      return gaCookie.substring(4); // Удаляем "_ga="
    }

    return '';
  }

  // Прочитать и сохранить UTM параметры из URL при загрузке страницы
  function captureUtmParams() {
    const params = new URLSearchParams(window.location.search);
    const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid', 'ttclid'];

    utmKeys.forEach(key => {
      if (params.has(key)) {
        cookies.set(`hf_${key}`, params.get(key));
      }
    });
  }

  // Получить URL страницы без UTM параметров, Click ID и фрагмента
  function getCleanPageUrl() {
    const url = new URL(window.location);
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
      'gclid', 'fbclid', 'ttclid'
    ];

    trackingParams.forEach(key => {
      url.searchParams.delete(key);
    });

    // Удалить фрагмент
    url.hash = '';

    return url.toString();
  }

  // Собрать все данные формы
  function collectFormData(form) {
    const data = {};

    // Добавить все поля из FormData (input, select, textarea)
    const formData = new FormData(form);
    for (const [key, value] of formData) {
      data[key] = value;
    }

    // Добавить служебные поля
    const formIndex = Array.from(document.querySelectorAll('form')).indexOf(form) + 1;
    const formName = form.name || form.id || `form_${formIndex}`;
    data.form_name = formName;
    data.page_url = getCleanPageUrl();

    // Добавить UTM параметры из куки
    const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    utmKeys.forEach(key => {
      data[key] = cookies.get(`hf_${key}`);
    });

    // Добавить click ID параметры из куки
    const clickIdKeys = ['gclid', 'fbclid', 'ttclid'];
    clickIdKeys.forEach(key => {
      data[key] = cookies.get(`hf_${key}`);
    });

    // Добавить Facebook параметры из браузерных куки
    data.fbp = cookies.get('_fbp');
    data.fbc = cookies.get('_fbc');

    // Добавить Google Analytics Client ID
    data.ga_client_id = getGAClientId();

    return data;
  }

  // Обёртка для отправки с гарантированным сбросом флага
  function sendWithStateReset(form, data) {
    // Вставляем сброс флага в оригинальную функцию через Promise
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    fetch(config.webhook, {
      method: 'POST',
      body: JSON.stringify(data),
      mode: 'no-cors',
      signal: controller.signal
    })
      .then(() => {
        clearTimeout(timeoutId);
        form.dispatchEvent(new CustomEvent('hookform:success'));
        return true;
      })
      .catch(error => {
        clearTimeout(timeoutId);

        let errorMessage = 'Неизвестная ошибка';
        if (error.name === 'AbortError') {
          errorMessage = `Timeout после ${config.timeout}ms`;
        } else if (error instanceof TypeError) {
          errorMessage = 'Сетевая ошибка или CORS проблема';
        } else if (error instanceof SyntaxError) {
          errorMessage = 'Ошибка в JSON данных';
        }

        console.error(`HookForm: Ошибка отправки на webhook (${errorMessage})`, error);
        form.dispatchEvent(new CustomEvent('hookform:error', {
          detail: { error: errorMessage }
        }));
        return false;
      });
  }

  // Навесить обработчик submit на форму
  function setupForm(form) {
    // Защита от повторного обрабатывания одной формы
    if (initialized.has(form)) {
      return;
    }
    initialized.add(form);

    // Флаг для защиты от double submit
    let isSubmitting = false;

    form.addEventListener('submit', function(e) {
      e.preventDefault();

      // Защита от двойного клика/отправки
      if (isSubmitting) {
        console.warn('HookForm: Форма уже отправляется, дождитесь завершения');
        return;
      }

      isSubmitting = true;

      // Отправить данные
      const data = collectFormData(form);
      sendWithStateReset(form, data)
        .finally(() => {
          // Сброс флага гарантирует, что кнопка разблокируется
          // только после завершения fetch (успех или ошибка)
          isSubmitting = false;
        });
    });
  }

  // Функция для подключения обработчиков к формам
  function attachFormHandlers() {
    const forms = document.querySelectorAll('form');
    if (forms.length === 0) {
      console.warn('HookForm: на странице не найдено ни одной <form>');
    }

    forms.forEach(form => {
      setupForm(form);
    });
  }

  // Главный API объект
  const HookForm = {
    init(options) {
      // Проверка обязательного параметра webhook
      if (!options || !options.webhook) {
        console.error('HookForm: webhook не передан в init()');
        return false;
      }

      // Валидация webhook URL
      if (!isValidWebhookUrl(options.webhook)) {
        console.error('HookForm: webhook должен быть валидным HTTP(S) URL:', options.webhook);
        return false;
      }

      config.webhook = options.webhook;

      // Опционально: переопределить таймаут (по умолчанию 10 сек)
      if (options.timeout && typeof options.timeout === 'number' && options.timeout > 0) {
        config.timeout = options.timeout;
      }

      // Прочитать UTM параметры из URL и сохранить в куки
      captureUtmParams();

      // Подключить обработчики к формам
      // Если DOM уже загружен, подключаем сразу. Иначе ждём DOMContentLoaded.
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', attachFormHandlers);
      } else {
        attachFormHandlers();
      }

      return true;
    }
  };

  // Экспортировать в глобальный скоуп
  window.HookForm = HookForm;
})();
