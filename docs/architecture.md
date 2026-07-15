# Архитектура QuizRoom

## Общая схема

```mermaid
flowchart LR
    O[Организатор] --> UI[React-интерфейс]
    P[Участник или гость] --> UI
    UI -->|REST: пользователи, квизы, история| API[Express API]
    UI <-->|Socket.IO: комната, вопрос, ответ, рейтинг| WS[Игровой сервер]
    API --> DB[(SQLite)]
    WS --> DB
    API --> FILES[Изображения вопросов]
```

REST API отвечает за долговременные сущности: пользователей, гостевые профили, квизы, вопросы и историю. Socket.IO используется для событий текущей игры и восстановления комнаты после обновления страницы. Результаты каждого ответа сразу сохраняются в SQLite, поэтому итоговый лидерборд и история не зависят от состояния браузера.

## Модель данных

```mermaid
erDiagram
    USERS ||--o{ QUIZZES : creates
    USERS ||--o{ SESSION_PLAYERS : joins
    USERS ||--o{ ANSWERS : submits
    QUIZZES ||--o{ QUESTIONS : contains
    QUIZZES ||--o{ QUIZ_SESSIONS : starts
    QUIZ_SESSIONS ||--o{ SESSION_PLAYERS : includes
    QUIZ_SESSIONS ||--o{ ANSWERS : collects
    QUESTIONS ||--o{ ANSWERS : receives

    USERS {
      int id PK
      string name
      string email UK
      string password_hash
      string role
    }
    QUIZZES {
      int id PK
      int organizer_id FK
      string title
      string category
      int question_time
      int points_per_question
    }
    QUESTIONS {
      int id PK
      int quiz_id FK
      string type
      string text
      string image_url
      json options
      json correct_answers
      string explanation
    }
    QUIZ_SESSIONS {
      int id PK
      int quiz_id FK
      string room_code UK
      string status
      int current_question
    }
    SESSION_PLAYERS {
      int session_id FK
      int user_id FK
      int score
    }
    ANSWERS {
      int session_id FK
      int question_id FK
      int user_id FK
      json answers
      bool is_correct
      int points
      int response_ms
    }
```

## Сценарий игры

```mermaid
sequenceDiagram
    participant O as Организатор
    participant S as Сервер
    participant P as Участники
    O->>S: Создать комнату
    S-->>O: Код комнаты и QR-ссылка
    P->>S: Подключиться по коду или как гость
    S-->>O: Обновлённый список участников
    O->>S: Запустить квиз
    S-->>P: Вопрос и время окончания
    P->>S: Отправить ответ
    S->>S: Проверить время и начислить баллы
    S-->>O: Количество ответивших
    S-->>P: Правильный ответ, пояснение и рейтинг
    S-->>O: Точность, время ответа и распределение вариантов
    O->>S: Следующий вопрос / завершить
    S-->>O: Итоговый лидерборд
    S-->>P: Итоговый лидерборд
```

Клиент сохраняет только код и роль активной комнаты. После обновления страницы он отправляет событие `room:resume`; сервер повторно проверяет права пользователя, возвращает текущий вопрос, принятый ответ и состояние таймера. QR-код создаётся локально, а ссылка автоматически открывает гостевой вход с заполненным кодом комнаты.

## Защита от некорректных действий

- сервер проверяет JWT при каждом REST-запросе и Socket.IO-подключении;
- управлять квизом может только его автор;
- один участник может отправить только один ответ на вопрос;
- ответ принимается только для текущего вопроса и до окончания таймера;
- правильные ответы не отправляются участникам до закрытия вопроса;
- тип и индексы выбранных вариантов проверяются на сервере.
