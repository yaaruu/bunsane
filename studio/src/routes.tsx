import { type RouteObject } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Welcome } from './pages/Welcome'
import { ArcheType } from './pages/ArcheType'
import { Table } from './pages/Table'

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
    ],
  },
]