export function addTodosEndpoints(app, db) {
  // POST /todos - Create a new todo
  app.post('/todos', async (req, res) => {
    const { title, completed } = req.body;

    // Validate title
    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'Title is required and must be a non-empty string.' });
    }

    // Determine completed status, default to false if not a boolean
    const isCompleted = typeof completed === 'boolean' ? completed : false;

    try {
      const result = await db.run(
        'INSERT INTO todos (title, completed) VALUES (?, ?)',
        [title.trim(), isCompleted ? 1 : 0] // SQLite stores booleans as 0 or 1
      );

      // Get the last inserted ID and return the new todo
      const newTodo = {
        id: result.lastID,
        title: title.trim(),
        completed: isCompleted,
      };
      res.status(201).json(newTodo);
    } catch (error) {
      console.error('Error creating todo:', error);
      res.status(500).json({ error: 'Failed to create todo.' });
    }
  });

  // GET /todos - Retrieve all todos
  app.get('/todos', async (req, res) => {
    try {
      const todos = await db.all('SELECT id, title, completed FROM todos');
      // Convert SQLite 0/1 to boolean for the response
      const formattedTodos = todos.map(todo => ({
        ...todo,
        completed: todo.completed === 1,
      }));
      res.status(200).json(formattedTodos);
    } catch (error) {
      console.error('Error retrieving todos:', error);
      res.status(500).json({ error: 'Failed to retrieve todos.' });
    }
  });
}