import { type RouteObject } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Welcome } from './pages/Welcome'
import { ArcheType } from './pages/ArcheType'
import { Table } from './pages/Table'
import { EntityInspector } from './pages/EntityInspector'
import { Components } from './pages/Components'
import { QueryRunner } from './pages/QueryRunner'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <Layout />,
    children: [
      {
        index: true,
        element: <Welcome />,
      },
      {
        path: 'archetype/:name',
        element: <ArcheType />,
      },
      {
        path: 'table/:name',
        element: <Table />,
      },
      {
        path: 'entity/:id',
        element: <EntityInspector />,
      },
      {
        path: 'entity',
        element: <EntityInspector />,
      },
      {
        path: 'components',
        element: <Components />,
      },
      {
        path: 'query',
        element: <QueryRunner />,
      },
    ],
  },
]